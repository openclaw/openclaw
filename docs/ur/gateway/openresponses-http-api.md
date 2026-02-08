---
summary: "Gateway سے OpenResponses کے مطابق /v1/responses HTTP اینڈپوائنٹ فراہم کریں"
read_when:
  - OpenResponses API بولنے والے کلائنٹس کو ضم کرتے وقت
  - آپ کو آئٹم پر مبنی اِن پٹس، کلائنٹ ٹول کالز، یا SSE ایونٹس درکار ہوں
title: "OpenResponses API"
x-i18n:
  source_path: gateway/openresponses-http-api.md
  source_hash: 0597714837f8b210
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:26Z
---

# OpenResponses API (HTTP)

OpenClaw کا Gateway ایک OpenResponses کے مطابق `POST /v1/responses` اینڈپوائنٹ فراہم کر سکتا ہے۔

یہ اینڈپوائنٹ **بطورِ طے شدہ غیرفعال** ہوتا ہے۔ پہلے کنفیگ میں اسے فعال کریں۔

- `POST /v1/responses`
- Gateway کے ساتھ ایک ہی پورٹ (WS + HTTP ملٹی پلیکس): `http://<gateway-host>:<port>/v1/responses`

پس منظر میں، درخواستیں ایک عام Gateway ایجنٹ رَن کے طور پر چلتی ہیں (وہی کوڈ پاتھ جیسا
`openclaw agent`), لہٰذا روٹنگ/اجازتیں/کنفیگ آپ کے Gateway کے مطابق رہتی ہیں۔

## Authentication

Gateway کی تصدیقی کنفیگریشن استعمال ہوتی ہے۔ بیئرر ٹوکن بھیجیں:

- `Authorization: Bearer <token>`

نوٹس:

- جب `gateway.auth.mode="token"` ہو، تو `gateway.auth.token` استعمال کریں (یا `OPENCLAW_GATEWAY_TOKEN`)۔
- جب `gateway.auth.mode="password"` ہو، تو `gateway.auth.password` استعمال کریں (یا `OPENCLAW_GATEWAY_PASSWORD`)۔

## Choosing an agent

کسی حسبِ ضرورت ہیڈر کی ضرورت نہیں: OpenResponses کے `model` فیلڈ میں ایجنٹ آئی ڈی انکوڈ کریں:

- `model: "openclaw:<agentId>"` (مثال: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (عرف)

یا ہیڈر کے ذریعے کسی مخصوص OpenClaw ایجنٹ کو ہدف بنائیں:

- `x-openclaw-agent-id: <agentId>` (بطورِ طے شدہ: `main`)

ایڈوانسڈ:

- سیشن روٹنگ پر مکمل کنٹرول کے لیے `x-openclaw-session-key: <sessionKey>`۔

## Enabling the endpoint

`gateway.http.endpoints.responses.enabled` کو `true` پر سیٹ کریں:

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

## Disabling the endpoint

`gateway.http.endpoints.responses.enabled` کو `false` پر سیٹ کریں:

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

## Session behavior

بطورِ طے شدہ اینڈپوائنٹ **ہر درخواست کے لیے اسٹیٹ لیس** ہوتا ہے (ہر کال پر ایک نیا سیشن کی جنریٹ کیا جاتا ہے)۔

اگر درخواست میں OpenResponses کا `user` اسٹرنگ شامل ہو، تو Gateway اسی سے ایک مستحکم سیشن کی اخذ کرتا ہے،
تاکہ بار بار کی کالز ایک ہی ایجنٹ سیشن شیئر کر سکیں۔

## Request shape (supported)

درخواست OpenResponses API کے مطابق آئٹم پر مبنی اِن پٹ کے ساتھ ہوتی ہے۔ موجودہ سپورٹ:

- `input`: اسٹرنگ یا آئٹم آبجیکٹس کی فہرست۔
- `instructions`: سسٹم پرامپٹ میں ضم کیا جاتا ہے۔
- `tools`: کلائنٹ ٹول کی تعریفیں (فنکشن ٹولز)۔
- `tool_choice`: کلائنٹ ٹولز کو فلٹر یا لازم قرار دینا۔
- `stream`: SSE اسٹریمنگ فعال کرتا ہے۔
- `max_output_tokens`: بہترین کوشش پر مبنی آؤٹ پٹ حد (فراہم کنندہ پر منحصر)۔
- `user`: مستحکم سیشن روٹنگ۔

قبول تو کیے جاتے ہیں مگر **فی الحال نظر انداز** کیے جاتے ہیں:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (input)

### `message`

کردار: `system`, `developer`, `user`, `assistant`۔

- `system` اور `developer` سسٹم پرامپٹ میں شامل کیے جاتے ہیں۔
- تازہ ترین `user` یا `function_call_output` آئٹم “موجودہ پیغام” بن جاتا ہے۔
- پہلے کے صارف/اسسٹنٹ پیغامات سیاق کے لیے تاریخ میں شامل رہتے ہیں۔

### `function_call_output` (ٹرن پر مبنی ٹولز)

ٹول کے نتائج ماڈل کو واپس بھیجیں:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` اور `item_reference`

اسکیما مطابقت کے لیے قبول ہیں مگر پرامپٹ بناتے وقت نظر انداز کیے جاتے ہیں۔

## Tools (client-side function tools)

`tools: [{ type: "function", function: { name, description?, parameters? } }]` کے ساتھ ٹولز فراہم کریں۔

اگر ایجنٹ کسی ٹول کو کال کرنے کا فیصلہ کرے، تو جواب میں `function_call` آؤٹ پٹ آئٹم واپس آتا ہے۔
اس کے بعد ٹرن جاری رکھنے کے لیے `function_call_output` کے ساتھ فالو اَپ درخواست بھیجیں۔

## Images (`input_image`)

base64 یا URL ذرائع کی سپورٹ:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

اجازت یافتہ MIME اقسام (فی الحال): `image/jpeg`, `image/png`, `image/gif`, `image/webp`۔
زیادہ سے زیادہ سائز (فی الحال): 10MB۔

## Files (`input_file`)

base64 یا URL ذرائع کی سپورٹ:

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

اجازت یافتہ MIME اقسام (فی الحال): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`۔

زیادہ سے زیادہ سائز (فی الحال): 5MB۔

موجودہ رویہ:

- فائل کا مواد ڈی کوڈ کر کے **سسٹم پرامپٹ** میں شامل کیا جاتا ہے، صارف کے پیغام میں نہیں،
  اس لیے یہ عارضی رہتا ہے (سیشن ہسٹری میں محفوظ نہیں ہوتا)۔
- PDFs سے متن نکالا جاتا ہے۔ اگر متن کم ملے تو ابتدائی صفحات کو راسٹرائز کر کے
  تصاویر کی صورت میں ماڈل کو بھیجا جاتا ہے۔

PDF پارسنگ Node کے لیے موزوں `pdfjs-dist` لیگیسی بلڈ استعمال کرتی ہے (بغیر ورکر)۔ جدید
PDF.js بلڈ براؤزر ورکرز/DOM گلوبلز کی توقع کرتا ہے، اس لیے Gateway میں استعمال نہیں کیا جاتا۔

URL فِچ کے بطورِ طے شدہ اختیارات:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- درخواستیں محفوظ طریقے سے کنٹرول کی جاتی ہیں (DNS ریزولوشن، پرائیویٹ IP بلاکنگ، ری ڈائریکٹ حدود، ٹائم آؤٹس)۔

## File + image limits (config)

ڈیفالٹس کو `gateway.http.endpoints.responses` کے تحت ایڈجسٹ کیا جا سکتا ہے:

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

جب متعین نہ ہوں تو ڈیفالٹس:

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

## Streaming (SSE)

Server-Sent Events (SSE) حاصل کرنے کے لیے `stream: true` سیٹ کریں:

- `Content-Type: text/event-stream`
- ہر ایونٹ لائن `event: <type>` اور `data: <json>` پر مشتمل ہوتی ہے
- اسٹریم `data: [DONE]` پر ختم ہوتی ہے

فی الحال خارج کیے جانے والے ایونٹ کی اقسام:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (غلطی کی صورت میں)

## Usage

جب بنیادی فراہم کنندہ ٹوکن کاؤنٹس رپورٹ کرتا ہے تو `usage` پُر کیا جاتا ہے۔

## Errors

غلطیاں درج ذیل جیسا JSON آبجیکٹ استعمال کرتی ہیں:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

عام معاملات:

- `401` تصدیق غائب/غلط
- `400` غلط درخواست باڈی
- `405` غلط طریقہ (method)

## Examples

نان اسٹریمنگ:

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

اسٹریمنگ:

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
