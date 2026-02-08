---
summary: "جاگنے اور علیحدہ ایجنٹ رنز کے لیے Webhook اِن گریس"
read_when:
  - Webhook اینڈپوائنٹس شامل یا تبدیل کرتے وقت
  - بیرونی نظاموں کو OpenClaw سے جوڑتے وقت
title: "Webhooks"
x-i18n:
  source_path: automation/webhook.md
  source_hash: f26b88864567be82
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:02Z
---

# Webhooks

Gateway بیرونی ٹرگرز کے لیے ایک چھوٹا HTTP webhook اینڈپوائنٹ فراہم کر سکتا ہے۔

## Enable

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Notes:

- `hooks.token` درکار ہے جب `hooks.enabled=true`۔
- `hooks.path` بطورِ طے شدہ `/hooks` ہوتا ہے۔

## Auth

ہر درخواست میں hook ٹوکن شامل ہونا لازم ہے۔ ہیڈرز کو ترجیح دیں:

- `Authorization: Bearer <token>` (سفارش کردہ)
- `x-openclaw-token: <token>`
- `?token=<token>` (متروک؛ وارننگ لاگ کرتا ہے اور مستقبل کی کسی بڑی ریلیز میں ہٹا دیا جائے گا)

## Endpoints

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **required** (string): ایونٹ کی وضاحت (مثلاً، "نیا ای میل موصول ہوا")۔
- `mode` optional (`now` | `next-heartbeat`): فوری ہارٹ بیٹ ٹرگر کرنا ہے یا اگلے دورانی چیک کا انتظار کرنا ہے (بطورِ طے شدہ `now`)۔

Effect:

- **main** سیشن کے لیے ایک سسٹم ایونٹ قطار میں شامل کرتا ہے
- اگر `mode=now` ہو تو فوری ہارٹ بیٹ ٹرگر کرتا ہے

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **required** (string): ایجنٹ کے لیے پروسیس کرنے کا پرامپٹ یا پیغام۔
- `name` optional (string): hook کے لیے انسانی قابلِ فہم نام (مثلاً، "GitHub")، جو سیشن خلاصوں میں بطور سابقہ استعمال ہوتا ہے۔
- `sessionKey` optional (string): ایجنٹ کے سیشن کی شناخت کے لیے استعمال ہونے والی کلید۔ بطورِ طے شدہ ایک رینڈم `hook:<uuid>`۔ مستقل کلید استعمال کرنے سے hook سیاق میں ملٹی ٹرن گفتگو ممکن ہوتی ہے۔
- `wakeMode` optional (`now` | `next-heartbeat`): فوری ہارٹ بیٹ ٹرگر کرنا ہے یا اگلے دورانی چیک کا انتظار کرنا ہے (بطورِ طے شدہ `now`)۔
- `deliver` optional (boolean): اگر `true` ہو تو ایجنٹ کا جواب میسجنگ چینل پر بھیجا جائے گا۔ بطورِ طے شدہ `true`۔ وہ جوابات جو صرف ہارٹ بیٹ کی توثیق ہوں خودکار طور پر نظرانداز کر دیے جاتے ہیں۔
- `channel` optional (string): ترسیل کے لیے میسجنگ چینل۔ ان میں سے ایک: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`۔ بطورِ طے شدہ `last`۔
- `to` optional (string): چینل کے لیے وصول کنندہ کی شناخت (مثلاً، WhatsApp/Signal کے لیے فون نمبر، Telegram کے لیے چیٹ ID، Discord/Slack/Mattermost (plugin) کے لیے چینل ID، MS Teams کے لیے گفتگو ID)۔ بطورِ طے شدہ main سیشن میں آخری وصول کنندہ۔
- `model` optional (string): ماڈل اووررائیڈ (مثلاً، `anthropic/claude-3-5-sonnet` یا کوئی عرف)۔ اگر پابندی ہو تو اجازت یافتہ ماڈلز کی فہرست میں ہونا لازم ہے۔
- `thinking` optional (string): تھنکنگ لیول اووررائیڈ (مثلاً، `low`, `medium`, `high`)۔
- `timeoutSeconds` optional (number): ایجنٹ رن کے لیے زیادہ سے زیادہ دورانیہ سیکنڈز میں۔

Effect:

- ایک **isolated** ایجنٹ ٹرن چلاتا ہے (اپنی سیشن کلید کے ساتھ)
- ہمیشہ **main** سیشن میں ایک خلاصہ پوسٹ کرتا ہے
- اگر `wakeMode=now` ہو تو فوری ہارٹ بیٹ ٹرگر کرتا ہے

### `POST /hooks/<name>` (mapped)

حسبِ ضرورت hook نام `hooks.mappings` کے ذریعے حل کیے جاتے ہیں (کنفیگریشن دیکھیں)۔ ایک میپنگ
من مانی payloads کو `wake` یا `agent` ایکشنز میں تبدیل کر سکتی ہے، اختیاری ٹیمپلیٹس یا
کوڈ ٹرانسفارمز کے ساتھ۔

Mapping options (summary):

- `hooks.presets: ["gmail"]` بلٹ اِن Gmail میپنگ کو فعال کرتا ہے۔
- `hooks.mappings` آپ کو کنفیگ میں `match`, `action`، اور ٹیمپلیٹس متعین کرنے دیتا ہے۔
- `hooks.transformsDir` + `transform.module` حسبِ ضرورت لاجک کے لیے JS/TS ماڈیول لوڈ کرتا ہے۔
- `match.source` استعمال کریں تاکہ ایک عام ingest اینڈپوائنٹ برقرار رہے (payload پر مبنی راؤٹنگ)۔
- TS ٹرانسفارمز کے لیے TS لوڈر درکار ہوتا ہے (مثلاً `bun` یا `tsx`) یا رَن ٹائم پر پہلے سے کمپائل شدہ `.js`۔
- جوابات کو چیٹ سطح پر راؤٹ کرنے کے لیے میپنگز پر `deliver: true` + `channel`/`to` سیٹ کریں
  (`channel` بطورِ طے شدہ `last` ہے اور WhatsApp پر فال بیک کرتا ہے)۔
- `allowUnsafeExternalContent: true` اس hook کے لیے بیرونی مواد کی حفاظت کے ریپر کو غیر فعال کرتا ہے
  (خطرناک؛ صرف قابلِ اعتماد اندرونی ذرائع کے لیے)۔
- `openclaw webhooks gmail setup` `openclaw webhooks gmail run` کے لیے `hooks.gmail` کنفیگ لکھتا ہے۔
  مکمل Gmail واچ فلو کے لیے [Gmail Pub/Sub](/automation/gmail-pubsub) دیکھیں۔

## Responses

- `200` برائے `/hooks/wake`
- `202` برائے `/hooks/agent` (async رن شروع ہو گیا)
- تصدیق کی ناکامی پر `401`
- غلط payload پر `400`
- حد سے بڑے payloads پر `413`

## Examples

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Use a different model

اس رن کے لیے ماڈل اووررائیڈ کرنے کو ایجنٹ payload (یا میپنگ) میں `model` شامل کریں:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

اگر آپ `agents.defaults.models` نافذ کرتے ہیں تو یقینی بنائیں کہ اووررائیڈ ماڈل اس میں شامل ہو۔

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Security

- hook اینڈپوائنٹس کو loopback، tailnet، یا قابلِ اعتماد ریورس پراکسی کے پیچھے رکھیں۔
- ایک مخصوص hook ٹوکن استعمال کریں؛ gateway کی auth ٹوکنز دوبارہ استعمال نہ کریں۔
- webhook لاگز میں حساس خام payloads شامل کرنے سے گریز کریں۔
- hook payloads کو بطورِ طے شدہ غیر قابلِ اعتماد سمجھا جاتا ہے اور حفاظتی حدود کے ساتھ لپیٹا جاتا ہے۔
  اگر کسی مخصوص hook کے لیے اسے غیر فعال کرنا ضروری ہو تو اس hook کی میپنگ میں `allowUnsafeExternalContent: true` سیٹ کریں
  (خطرناک)۔
