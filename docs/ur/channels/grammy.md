---
summary: "grammY کے ذریعے Telegram Bot API انضمام بمع سیٹ اپ نوٹس"
read_when:
  - Telegram یا grammY راستوں پر کام کرتے وقت
title: grammY
x-i18n:
  source_path: channels/grammy.md
  source_hash: ea7ef23e6d77801f
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:53Z
---

# grammY انضمام (Telegram Bot API)

# grammY کیوں

- TS-first Bot API کلائنٹ جس میں بلٹ اِن long-poll + webhook ہیلپرز، middleware، error handling، اور rate limiter شامل ہیں۔
- fetch + FormData کو دستی طور پر بنانے کے مقابلے میں زیادہ صاف میڈیا ہیلپرز؛ Bot API کے تمام طریقوں کی سپورٹ۔
- قابلِ توسیع: custom fetch کے ذریعے proxy سپورٹ، session middleware (اختیاری)، type-safe context۔

# ہم نے کیا بھیجا

- **واحد کلائنٹ راستہ:** fetch پر مبنی نفاذ ہٹا دیا گیا؛ grammY اب واحد Telegram کلائنٹ ہے (send + gateway) اور grammY throttler بطورِ طے شدہ فعال ہے۔
- **Gateway:** `monitorTelegramProvider` ایک grammY `Bot` بناتا ہے، mention/allowlist gating وائر کرتا ہے، `getFile`/`download` کے ذریعے میڈیا ڈاؤن لوڈ کرتا ہے، اور `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument` کے ساتھ جوابات پہنچاتا ہے۔ `webhookCallback` کے ذریعے long-poll یا webhook کی سپورٹ۔
- **Proxy:** اختیاری `channels.telegram.proxy` grammY کے `client.baseFetch` کے ذریعے `undici.ProxyAgent` استعمال کرتا ہے۔
- **Webhook سپورٹ:** `webhook-set.ts`، `setWebhook/deleteWebhook` کو ریپ کرتا ہے؛ `webhook.ts` صحت (health) اور graceful shutdown کے ساتھ callback ہوسٹ کرتا ہے۔ Gateway اس وقت webhook موڈ فعال کرتا ہے جب `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` سیٹ ہوں (ورنہ یہ long-poll کرتا ہے)۔
- **Sessions:** براہِ راست چیٹس ایجنٹ کے مرکزی سیشن (`agent:<agentId>:<mainKey>`) میں ضم ہو جاتی ہیں؛ گروپس `agent:<agentId>:telegram:group:<chatId>` استعمال کرتے ہیں؛ جوابات اسی چینل پر واپس جاتے ہیں۔
- **Config knobs:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (allowlist + mention ڈیفالٹس), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`۔
- **Draft streaming:** اختیاری `channels.telegram.streamMode` نجی topic چیٹس میں `sendMessageDraft` استعمال کرتا ہے (Bot API 9.3+)۔ یہ چینل بلاک اسٹریمنگ سے الگ ہے۔
- **Tests:** grammY mocks DM + گروپ mention gating اور outbound send کو کور کرتے ہیں؛ مزید میڈیا/webhook fixtures خوش آئند ہیں۔

Open questions

- اگر Bot API 429s آئیں تو اختیاری grammY plugins (throttler)۔
- مزید ساختہ میڈیا ٹیسٹس شامل کرنا (اسٹیکرز، وائس نوٹس)۔
- webhook کے listen پورٹ کو قابلِ کنفیگریشن بنانا (فی الحال 8787 پر فکس ہے جب تک gateway کے ذریعے وائر نہ کیا جائے)۔
