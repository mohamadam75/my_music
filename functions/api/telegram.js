// Cloudflare Pages Function: Telegram webhook.
// Configure TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and optional TELEGRAM_ALLOWED_USER_ID
// as encrypted environment variables. Bind a Cloudflare KV namespace named MUSIC_KV.
const api = (token, method, body) => fetch(`https://api.telegram.org/bot${token}/${method}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});
const esc = s => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
async function send(token, chat_id, text, extra = {}) {
  return api(token, "sendMessage", { chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}
async function searchSongs(q) {
  const url = "https://itunes.apple.com/search?entity=song&limit=8&term=" + encodeURIComponent(q);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Music search failed");
  const data = await res.json();
  return (data.results || []).map(x => ({
    id: String(x.trackId), title: x.trackName || "بدون عنوان", artist: x.artistName || "نامشخص",
    album: x.collectionName || "", cover: x.artworkUrl100 || "", preview: x.previewUrl || "", url: x.trackViewUrl || ""
  }));
}
export async function onRequestPost({ request, env }) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.MUSIC_KV) {
    return new Response("Telegram integration is not configured", { status: 503 });
  }
  if (request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  let update;
  try { update = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }
  const msg = update.message;
  const cb = update.callback_query;
  const from = msg?.from || cb?.from;
  const chatId = msg?.chat?.id || cb?.message?.chat?.id;
  if (!from || !chatId) return new Response("ok");
  if (env.TELEGRAM_ALLOWED_USER_ID && String(from.id) !== String(env.TELEGRAM_ALLOWED_USER_ID)) {
    if (cb) await api(env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "این ربات خصوصی است." });
    else await send(env.TELEGRAM_BOT_TOKEN, chatId, "⛔ دسترسی به این ربات مجاز نیست.");
    return new Response("ok");
  }
  const key = "favorites:" + from.id;
  if (cb?.data?.startsWith("fav:")) {
    const id = cb.data.slice(4);
    const raw = await env.MUSIC_KV.get(key);
    const favs = raw ? JSON.parse(raw) : [];
    const track = await env.MUSIC_KV.get("track:" + id, "json");
    if (!track) {
      await api(env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: "اول یک آهنگ جست‌وجو کن." });
      return new Response("ok");
    }
    const i = favs.findIndex(t => t.id === id);
    if (i >= 0) favs.splice(i, 1); else favs.unshift(track);
    await env.MUSIC_KV.put(key, JSON.stringify(favs.slice(0, 200)));
    await api(env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", { callback_query_id: cb.id, text: i >= 0 ? "از پلی‌لیست حذف شد" : "به پلی‌لیست اضافه شد ⭐" });
    return new Response("ok");
  }
  const text = (msg?.text || "").trim();
  const command = text.match(/^\/(start|help|favorites)(?:@\w+)?(?:\s|$)/i);
  const searchCommand = text.match(/^\/search(?:@\w+)?(?:\s+([\s\S]*))?$/i);
  if (command?.[1]?.toLowerCase() === "start") {
    await send(env.TELEGRAM_BOT_TOKEN, chatId, "🎵 <b>موزیک من</b>\n\nاسم آهنگ یا خواننده را مستقیم بفرست تا جست‌وجو کنم.\n/search نام آهنگ — جست‌وجوی موسیقی\n/favorites — پلی‌لیست ستاره‌دار من\n/help — راهنما\n\nجست‌وجو فعلاً از کاتالوگ iTunes انجام می‌شود؛ جست‌وجوی تکه‌ای از متن ترانه هنوز پشتیبانی نمی‌شود.");
  } else if (command?.[1]?.toLowerCase() === "help") {
    await send(env.TELEGRAM_BOT_TOKEN, chatId, "اسم آهنگ یا خواننده را مستقیم بفرست، یا بنویس:\n<code>/search نام خواننده یا آهنگ</code>\n\nبرای دیدن موارد ستاره‌دار: /favorites");
  } else if (command?.[1]?.toLowerCase() === "favorites") {
    const favs = await env.MUSIC_KV.get(key, "json") || [];
    if (!favs.length) await send(env.TELEGRAM_BOT_TOKEN, chatId, "پلی‌لیستت فعلاً خالی است. اسم یک آهنگ را بفرست تا جست‌وجو کنیم.");
    else {
      const lines = favs.slice(0, 40).map((t, i) => `${i + 1}. <a href="${esc(t.url)}">${esc(t.title)}</a> — ${esc(t.artist)}`).join("\n");
      await send(env.TELEGRAM_BOT_TOKEN, chatId, "⭐ <b>پلی‌لیست من</b>\n\n" + lines);
    }
  } else if (searchCommand || (text && !text.startsWith("/"))) {
    const q = searchCommand ? (searchCommand[1] || "").trim() : text;
    if (!q) {
      await send(env.TELEGRAM_BOT_TOKEN, chatId, "بعد از /search نام آهنگ یا خواننده را بنویس.");
      return new Response("ok");
    }
    try {
      const tracks = await searchSongs(q);
      if (!tracks.length) {
        await send(env.TELEGRAM_BOT_TOKEN, chatId, "نتیجه‌ای پیدا نشد. نام خواننده یا آهنگ دیگری امتحان کن.");
      }
      for (const t of tracks.slice(0, 8)) {
        await env.MUSIC_KV.put("track:" + t.id, JSON.stringify(t), { expirationTtl: 86400 });
        await send(env.TELEGRAM_BOT_TOKEN, chatId, `🎵 <b>${esc(t.title)}</b>\n${esc(t.artist)}\n${t.album ? esc(t.album) + "\n" : ""}${t.preview ? '<a href="' + esc(t.preview) + '">پیش‌نمایش صوتی</a> · ' : ""}${t.url ? '<a href="' + esc(t.url) + '">بازکردن منبع</a>' : ""}`,
          { reply_markup: { inline_keyboard: [[{ text: "⭐ افزودن/حذف از پلی‌لیست", callback_data: "fav:" + t.id }]] } });
      }
    } catch {
      await send(env.TELEGRAM_BOT_TOKEN, chatId, "فعلاً جست‌وجو در دسترس نیست؛ کمی بعد دوباره امتحان کن.");
    }
  } else {
    await send(env.TELEGRAM_BOT_TOKEN, chatId, "برای شروع /start را بزن یا اسم آهنگ را مستقیم بفرست.");
  }
  return new Response("ok");
}
export async function onRequestGet() {
  return new Response("Telegram webhook endpoint is alive. Configure the webhook using the setup instructions.", { headers: { "content-type": "text/plain; charset=utf-8" } });
}
