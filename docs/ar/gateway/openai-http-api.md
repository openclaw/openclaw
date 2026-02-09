---
summary: "إتاحة نقطة نهاية HTTP متوافقة مع OpenAI لمسار ‎/v1/chat/completions‎ من Gateway"
read_when:
  - دمج الأدوات التي تتوقع OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

يمكن لـ Gateway في OpenClaw تقديم نقطة نهاية صغيرة متوافقة مع OpenAI لـ Chat Completions.

هذه النقطة **معطّلة افتراضيًا**. يجب تفعيلها أولًا في التهيئة.

- `POST /v1/chat/completions`
- نفس المنفذ الخاص بـ Gateway (تعدد WS + HTTP): `http://<gateway-host>:<port>/v1/chat/completions`

داخليًا، تُنفَّذ الطلبات كتشغيل عادي لوكيل Gateway (نفس مسار الشيفرة مثل `openclaw agent`)، لذلك تتطابق سياسات التوجيه/الأذونات/التهيئة مع Gateway لديك.

## المصادقة

تستخدم تهيئة مصادقة Gateway. أرسل رمز حامل (Bearer):

- `Authorization: Bearer <token>`

ملاحظات:

- عند `gateway.auth.mode="token"`، استخدم `gateway.auth.token` (أو `OPENCLAW_GATEWAY_TOKEN`).
- عند `gateway.auth.mode="password"`، استخدم `gateway.auth.password` (أو `OPENCLAW_GATEWAY_PASSWORD`).

## اختيار وكيل

لا تتطلب رؤوسًا مخصّصة: شفِّر معرّف الوكيل في حقل OpenAI `model`:

- `model: "openclaw:<agentId>"` (مثال: `"openclaw:main"`، `"openclaw:beta"`)
- `model: "agent:<agentId>"` (اسم بديل)

أو استهدف وكيل OpenClaw محددًا عبر رأس:

- `x-openclaw-agent-id: <agentId>` (الافتراضي: `main`)

متقدم:

- `x-openclaw-session-key: <sessionKey>` للتحكم الكامل في توجيه الجلسة.

## تفعيل نقطة النهاية

اضبط `gateway.http.endpoints.chatCompletions.enabled` إلى `true`:

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

## تعطيل نقطة النهاية

اضبط `gateway.http.endpoints.chatCompletions.enabled` إلى `false`:

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

## سلوك الجلسة

افتراضيًا تكون نقطة النهاية **عديمة الحالة لكل طلب** (يتم إنشاء مفتاح جلسة جديد في كل استدعاء).

إذا تضمّن الطلب سلسلة OpenAI `user`، فإن Gateway يشتق مفتاح جلسة ثابتًا منها، بحيث يمكن للاستدعاءات المتكررة مشاركة جلسة وكيل واحدة.

## البث (SSE)

اضبط `stream: true` لتلقي أحداث Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- كل سطر حدث هو `data: <json>`
- ينتهي البث بـ `data: [DONE]`

## أمثلة

غير متدفق:

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

متدفق:

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
