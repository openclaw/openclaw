---
summary: "Gateway سے OpenAI-مطابقت رکھنے والا /v1/chat/completions HTTP اینڈپوائنٹ فراہم کریں"
read_when:
  - ایسے ٹولز کے انضمام کے وقت جو OpenAI Chat Completions کی توقع رکھتے ہوں
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw کا Gateway ایک چھوٹا OpenAI-مطابقت رکھنے والا Chat Completions اینڈپوائنٹ فراہم کر سکتا ہے۔

This endpoint is **disabled by default**. Enable it in config first.

- `POST /v1/chat/completions`
- Gateway ہی کا پورٹ (WS + HTTP ملٹی پلیکس): `http://<gateway-host>:<port>/v1/chat/completions`

پسِ پردہ، درخواستیں ایک عام Gateway ایجنٹ رَن کے طور پر چلتی ہیں (وہی کوڈ پاتھ جیسا کہ `openclaw agent`)، اس لیے روٹنگ/اجازتیں/کنفیگ آپ کے Gateway سے مطابقت رکھتی ہیں۔

## تصدیق

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

نوٹس:

- جب `gateway.auth.mode="token"` ہو، تو `gateway.auth.token` استعمال کریں (یا `OPENCLAW_GATEWAY_TOKEN`)۔
- جب `gateway.auth.mode="password"` ہو، تو `gateway.auth.password` استعمال کریں (یا `OPENCLAW_GATEWAY_PASSWORD`)۔

## ایجنٹ کا انتخاب

کسی کسٹم ہیڈر کی ضرورت نہیں: OpenAI کے `model` فیلڈ میں ایجنٹ آئی ڈی انکوڈ کریں:

- `model: "openclaw:<agentId>"` (مثال: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (عرف)

یا ہیڈر کے ذریعے کسی مخصوص OpenClaw ایجنٹ کو ہدف بنائیں:

- `x-openclaw-agent-id: <agentId>` (بطورِ طے شدہ: `main`)

اعلٰی درجے کے استعمال کے لیے:

- سیشن روٹنگ پر مکمل کنٹرول کے لیے `x-openclaw-session-key: <sessionKey>`۔

## اینڈپوائنٹ کو فعال کرنا

`gateway.http.endpoints.chatCompletions.enabled` کو `true` پر سیٹ کریں:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## اینڈپوائنٹ کو غیرفعال کرنا

`gateway.http.endpoints.chatCompletions.enabled` کو `false` پر سیٹ کریں:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## سیشن کا برتاؤ

بطورِ طے شدہ، یہ اینڈپوائنٹ **ہر درخواست کے لیے اسٹیٹ لیس** ہوتا ہے (ہر کال پر ایک نیا سیشن کی تیار کیا جاتا ہے)۔

اگر درخواست میں OpenAI کی `user` اسٹرنگ شامل ہو، تو Gateway اس سے ایک مستحکم سیشن کی اخذ کرتا ہے، تاکہ بار بار کی جانے والی کالز ایک ہی ایجنٹ سیشن شیئر کر سکیں۔

## اسٹریمنگ (SSE)

Server-Sent Events (SSE) حاصل کرنے کے لیے `stream: true` سیٹ کریں:

- `Content-Type: text/event-stream`
- ہر ایونٹ لائن `data: <json>` ہوتی ہے
- اسٹریم `data: [DONE]` پر ختم ہوتی ہے

## مثالیں

غیر اسٹریمنگ:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

اسٹریمنگ:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
