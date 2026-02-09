---
summary: "Gateway HTTP اینڈپوائنٹ کے ذریعے ایک واحد ٹول کو براہِ راست چلائیں"
read_when:
  - مکمل ایجنٹ ٹرن چلائے بغیر ٹولز کو کال کرنا
  - ایسی آٹومیشنز بنانا جنہیں ٹول پالیسی کے نفاذ کی ضرورت ہو
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaw’s Gateway exposes a simple HTTP endpoint for invoking a single tool directly. It is always enabled, but gated by Gateway auth and tool policy.

- `POST /tools/invoke`
- Gateway کے ساتھ وہی پورٹ (WS + HTTP ملٹی پلیک্স): `http://<gateway-host>:<port>/tools/invoke`

بطورِ طے شدہ زیادہ سے زیادہ پے لوڈ سائز 2 MB ہے۔

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

نوٹس:

- جب `gateway.auth.mode="token"` ہو، تو `gateway.auth.token` استعمال کریں (یا `OPENCLAW_GATEWAY_TOKEN`)۔
- جب `gateway.auth.mode="password"` ہو، تو `gateway.auth.password` استعمال کریں (یا `OPENCLAW_GATEWAY_PASSWORD`)۔

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Fields:

- `tool` (string، لازم): چلانے کے لیے ٹول کا نام۔
- `action` (string، اختیاری): اگر ٹول اسکیما `action` کی حمایت کرتا ہو اور args پے لوڈ میں اسے چھوڑ دیا گیا ہو تو اسے args میں میپ کیا جاتا ہے۔
- `args` (object، اختیاری): ٹول سے مخصوص آرگیومنٹس۔
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and default agent, or `global` in global scope).
- `dryRun` (boolean، اختیاری): مستقبل کے استعمال کے لیے محفوظ؛ فی الحال نظرانداز کیا جاتا ہے۔

## Policy + routing behavior

ٹول کی دستیابی Gateway ایجنٹس کے زیرِ استعمال اسی پالیسی چین کے ذریعے فلٹر ہوتی ہے:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- گروپ پالیسیاں (اگر سیشن کلید کسی گروپ یا چینل سے میپ ہوتی ہو)
- سب ایجنٹ پالیسی (جب سب ایجنٹ سیشن کلید کے ساتھ چلایا جائے)

اگر کوئی ٹول پالیسی کے تحت اجازت یافتہ نہ ہو تو اینڈپوائنٹ **404** واپس کرتا ہے۔

گروپ پالیسیوں کو سیاق حل کرنے میں مدد دینے کے لیے، آپ اختیاری طور پر یہ سیٹ کر سکتے ہیں:

- `x-openclaw-message-channel: <channel>` (مثال: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (جب متعدد اکاؤنٹس موجود ہوں)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (غلط درخواست یا ٹول کی خرابی)
- `401` → غیر مجاز
- `404` → ٹول دستیاب نہیں (نہ ملا یا اجازت فہرست میں شامل نہیں)
- `405` → طریقہ کار کی اجازت نہیں

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
