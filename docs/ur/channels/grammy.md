---
summary: "grammY کے ذریعے Telegram Bot API انضمام بمع سیٹ اپ نوٹس"
read_when:
  - Telegram یا grammY راستوں پر کام کرتے وقت
title: grammY
---

# grammY انضمام (Telegram Bot API)

# grammY کیوں

- TS-first Bot API کلائنٹ جس میں بلٹ اِن long-poll + webhook ہیلپرز، middleware، error handling، اور rate limiter شامل ہیں۔
- fetch + FormData کو دستی طور پر بنانے کے مقابلے میں زیادہ صاف میڈیا ہیلپرز؛ Bot API کے تمام طریقوں کی سپورٹ۔
- قابلِ توسیع: custom fetch کے ذریعے proxy سپورٹ، session middleware (اختیاری)، type-safe context۔

# ہم نے کیا بھیجا

- **واحد کلائنٹ راستہ:** fetch پر مبنی نفاذ ہٹا دیا گیا؛ grammY اب واحد Telegram کلائنٹ ہے (send + gateway) اور grammY throttler بطورِ طے شدہ فعال ہے۔
- **Gateway:** `monitorTelegramProvider` builds a grammY `Bot`, wires mention/allowlist gating, media download via `getFile`/`download`, and delivers replies with `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Supports long-poll or webhook via `webhookCallback`.
- **Proxy:** اختیاری `channels.telegram.proxy` grammY کے `client.baseFetch` کے ذریعے `undici.ProxyAgent` استعمال کرتا ہے۔
- **Webhook support:** `webhook-set.ts` wraps `setWebhook/deleteWebhook`; `webhook.ts` hosts the callback with health + graceful shutdown. Gateway enables webhook mode when `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` are set (otherwise it long-polls).
- **Sessions:** براہِ راست چیٹس ایجنٹ کے مرکزی سیشن (`agent:<agentId>:<mainKey>`) میں ضم ہو جاتی ہیں؛ گروپس `agent:<agentId>:telegram:group:<chatId>` استعمال کرتے ہیں؛ جوابات اسی چینل پر واپس جاتے ہیں۔
- **Config knobs:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mention ڈیفالٹس), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`۔
- **Draft streaming:** optional `channels.telegram.streamMode` uses `sendMessageDraft` in private topic chats (Bot API 9.3+). This is separate from channel block streaming.
- **Tests:** grammY mocks DM + گروپ mention gating اور outbound send کو کور کرتے ہیں؛ مزید میڈیا/webhook fixtures خوش آئند ہیں۔

Open questions

- اگر Bot API 429s آئیں تو اختیاری grammY plugins (throttler)۔
- مزید ساختہ میڈیا ٹیسٹس شامل کرنا (اسٹیکرز، وائس نوٹس)۔
- webhook کے listen پورٹ کو قابلِ کنفیگریشن بنانا (فی الحال 8787 پر فکس ہے جب تک gateway کے ذریعے وائر نہ کیا جائے)۔
