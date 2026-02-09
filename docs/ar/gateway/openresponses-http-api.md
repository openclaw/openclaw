---
summary: "إتاحة نقطة نهاية HTTP ‏/v1/responses متوافقة مع OpenResponses من خلال Gateway"
read_when:
  - دمج العملاء الذين يتحدثون واجهة OpenResponses API
  - عندما تريد مدخلات قائمة على العناصر، أو استدعاءات أدوات من العميل، أو أحداث SSE
title: "واجهة OpenResponses API"
---

# واجهة OpenResponses API (HTTP)

يمكن لـ Gateway في OpenClaw تقديم نقطة نهاية متوافقة مع OpenResponses باسم `POST /v1/responses`.

هذه النقطة **معطّلة افتراضيًا**. قم بتمكينها في التهيئة أولًا.

- `POST /v1/responses`
- نفس المنفذ الخاص بـ Gateway (تعدد WS + HTTP): `http://<gateway-host>:<port>/v1/responses`

تحت الغطاء، تُنفَّذ الطلبات كتشغيل عادي لوكيل Gateway (نفس مسار الشيفرة مثل
`openclaw agent`)، لذا فإن التوجيه/الأذونات/التهيئة تطابق إعدادات Gateway لديك.

## المصادقة

تستخدم تهيئة مصادقة Gateway. أرسل رمز Bearer:

- `Authorization: Bearer <token>`

ملاحظات:

- عند `gateway.auth.mode="token"`، استخدم `gateway.auth.token` (أو `OPENCLAW_GATEWAY_TOKEN`).
- عند `gateway.auth.mode="password"`، استخدم `gateway.auth.password` (أو `OPENCLAW_GATEWAY_PASSWORD`).

## اختيار وكيل

لا حاجة إلى رؤوس مخصّصة: شفّر معرّف الوكيل في حقل OpenResponses ‏`model`:

- `model: "openclaw:<agentId>"` (مثال: `"openclaw:main"`، `"openclaw:beta"`)
- `model: "agent:<agentId>"` (اسم مستعار)

أو استهدف وكيل OpenClaw محددًا عبر رأس:

- `x-openclaw-agent-id: <agentId>` (الافتراضي: `main`)

متقدم:

- `x-openclaw-session-key: <sessionKey>` للتحكم الكامل في توجيه الجلسة.

## تمكين نقطة النهاية

عيّن `gateway.http.endpoints.responses.enabled` إلى `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## تعطيل نقطة النهاية

عيّن `gateway.http.endpoints.responses.enabled` إلى `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## سلوك الجلسة

افتراضيًا تكون نقطة النهاية **عديمة الحالة لكل طلب** (يُنشأ مفتاح جلسة جديد لكل استدعاء).

إذا تضمّن الطلب سلسلة OpenResponses ‏`user`، يستمدّ Gateway مفتاح جلسة ثابتًا
منها، بحيث يمكن للمكالمات المتكررة مشاركة جلسة الوكيل.

## شكل الطلب (المدعوم)

يتبع الطلب واجهة OpenResponses API مع مدخلات قائمة على العناصر. الدعم الحالي:

- `input`: سلسلة نصية أو مصفوفة من كائنات العناصر.
- `instructions`: يُدمَج في مطالبة النظام.
- `tools`: تعريفات أدوات العميل (أدوات الدوال).
- `tool_choice`: تصفية أدوات العميل أو فرضها.
- `stream`: يفعّل بث SSE.
- `max_output_tokens`: حد إخراج بأفضل جهد (يعتمد على الموفّر).
- `user`: توجيه جلسة ثابت.

مقبول ولكن **مُتجاهَل حاليًا**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## العناصر (المدخلات)

### `message`

الأدوار: `system`، `developer`، `user`، `assistant`.

- يُلحَق كلٌّ من `system` و`developer` بمطالبة النظام.
- يصبح أحدث عنصر من `user` أو `function_call_output` هو «الرسالة الحالية».
- تُضمَّن رسائل المستخدم/المساعد الأقدم كسجل تاريخي للسياق.

### `function_call_output` (أدوات قائمة على الأدوار)

أرسل نتائج الأدوات مرة أخرى إلى النموذج:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` و`item_reference`

مقبولة للتوافق مع المخطط لكنها مُتجاهَلة عند بناء المطالبة.

## الأدوات (أدوات دوال من جانب العميل)

قدّم الأدوات باستخدام `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

إذا قرر الوكيل استدعاء أداة، تُعيد الاستجابة عنصر إخراج `function_call`.
بعد ذلك ترسل طلب متابعة مع `function_call_output` لمواصلة الدور.

## الصور (`input_image`)

يدعم مصادر base64 أو عناوين URL:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

أنواع MIME المسموح بها (حاليًا): `image/jpeg`، `image/png`، `image/gif`، `image/webp`.
الحد الأقصى للحجم (حاليًا): 10MB.

## الملفات (`input_file`)

يدعم مصادر base64 أو عناوين URL:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

أنواع MIME المسموح بها (حاليًا): `text/plain`، `text/markdown`، `text/html`، `text/csv`،
`application/json`، `application/pdf`.

الحد الأقصى للحجم (حاليًا): 5MB.

السلوك الحالي:

- يُفك ترميز محتوى الملف ويُضاف إلى **مطالبة النظام**، وليس رسالة المستخدم،
  بحيث يظل مؤقتًا (غير محفوظ في سجل الجلسة).
- تُحلَّل ملفات PDF لاستخراج النص. إذا وُجد نص قليل، تُحوَّل الصفحات الأولى إلى صور
  وتُمرَّر إلى النموذج.

يستخدم تحليل PDF الإصدار القديم الملائم لـ Node من `pdfjs-dist` (من دون عامل). يتوقع
إصدار PDF.js الحديث عمّال متصفح/متغيرات DOM، لذا لا يُستخدم في Gateway.

الإعدادات الافتراضية لجلب عناوين URL:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- الطلبات محمية (حل DNS، حظر عناوين IP الخاصة، حدود إعادة التوجيه، مهلات).

## حدود الملفات والصور (التهيئة)

يمكن ضبط القيم الافتراضية ضمن `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

القيم الافتراضية عند عدم التحديد:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## البث (SSE)

عيّن `stream: true` لتلقي أحداث Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- كل سطر حدث هو `event: <type>` و`data: <json>`
- ينتهي البث بـ `data: [DONE]`

أنواع الأحداث المُصدَرة حاليًا:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (عند الخطأ)

## الاستخدام

"الاستخدام" يكون مأهولاً عندما يبلغ مقدم الخدمة الأساسي عن عدد الرموز.

## الأخطاء

تستخدم الأخطاء كائن JSON مثل:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

حالات شائعة:

- `401` مصادقة مفقودة/غير صالحة
- `400` جسم طلب غير صالح
- `405` طريقة خاطئة

## أمثلة

بدون بث:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

متدفق:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
