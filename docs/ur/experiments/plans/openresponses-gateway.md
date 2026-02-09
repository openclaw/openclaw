---
summary: "منصوبہ: OpenResponses /v1/responses اینڈپوائنٹ شامل کرنا اور چیٹ کمپلیشنز کو صاف انداز میں فرسودہ کرنا"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway منصوبہ"
---

# OpenResponses Gateway انضمام منصوبہ

## سیاق و سباق

OpenClaw Gateway اس وقت OpenAI کے ساتھ مطابقت رکھنے والا ایک کم از کم Chat Completions اینڈپوائنٹ فراہم کرتا ہے
`/v1/chat/completions` پر (دیکھیں [OpenAI Chat Completions](/gateway/openai-http-api))۔

Open Responses ایک اوپن inference اسٹینڈرڈ ہے جو OpenAI Responses API پر مبنی ہے۔ یہ agentic workflows کے لیے ڈیزائن کیا گیا ہے اور item-based inputs کے ساتھ semantic streaming events استعمال کرتا ہے۔ OpenResponses
spec `/v1/responses` کی وضاحت کرتا ہے، نہ کہ `/v1/chat/completions`۔

## اہداف

- ایک `/v1/responses` اینڈپوائنٹ شامل کرنا جو OpenResponses معنویات کی پابندی کرے۔
- Chat Completions کو ایک مطابقتی پرت کے طور پر برقرار رکھنا جو آسانی سے غیر فعال کی جا سکے اور بالآخر ہٹا دی جائے۔
- توثیق اور پارسنگ کو علیحدہ، قابلِ دوبارہ استعمال اسکیماز کے ساتھ معیاری بنانا۔

## غیر اہداف

- پہلی کوشش میں مکمل OpenResponses فیچر برابری (تصاویر، فائلیں، ہوسٹڈ ٹولز)۔
- اندرونی ایجنٹ ایکزیکیوشن لاجک یا ٹول آرکیسٹریشن کو تبدیل کرنا۔
- پہلے مرحلے کے دوران موجودہ `/v1/chat/completions` رویّے میں تبدیلی۔

## تحقیقی خلاصہ

ذرائع: OpenResponses OpenAPI، OpenResponses اسپیسفیکیشن سائٹ، اور Hugging Face بلاگ پوسٹ۔

اہم نکات:

- `POST /v1/responses` `CreateResponseBody` فیلڈز قبول کرتا ہے جیسے `model`، `input` (اسٹرنگ یا
  `ItemParam[]`)، `instructions`، `tools`، `tool_choice`، `stream`، `max_output_tokens`، اور
  `max_tool_calls`۔
- `ItemParam` ایک ڈسکرمنیٹڈ یونین ہے جس میں شامل ہیں:
  - `message` آئٹمز جن کے رولز `system`، `developer`، `user`، `assistant` ہیں
  - `function_call` اور `function_call_output`
  - `reasoning`
  - `item_reference`
- کامیاب ریسپانسز ایک `ResponseResource` واپس کرتے ہیں جس میں `object: "response"`، `status`، اور
  `output` آئٹمز ہوتے ہیں۔
- اسٹریمنگ معنوی ایونٹس استعمال کرتی ہے جیسے:
  - `response.created`، `response.in_progress`، `response.completed`، `response.failed`
  - `response.output_item.added`، `response.output_item.done`
  - `response.content_part.added`، `response.content_part.done`
  - `response.output_text.delta`، `response.output_text.done`
- اسپیک کے تقاضے:
  - `Content-Type: text/event-stream`
  - `event:` کو JSON کے `type` فیلڈ سے مماثل ہونا لازم ہے
  - آخری ایونٹ لفظی طور پر `[DONE]` ہونا چاہیے
- ریذننگ آئٹمز `content`، `encrypted_content`، اور `summary` کو ظاہر کر سکتے ہیں۔
- HF مثالوں میں درخواستوں میں `OpenResponses-Version: latest` شامل ہے (اختیاری ہیڈر)۔

## مجوزہ آرکیٹیکچر

- صرف Zod اسکیماز پر مشتمل `src/gateway/open-responses.schema.ts` شامل کریں (کوئی Gateway امپورٹس نہیں)۔
- `/v1/responses` کے لیے `src/gateway/openresponses-http.ts` (یا `open-responses-http.ts`) شامل کریں۔
- `src/gateway/openai-http.ts` کو بطور لیگیسی مطابقتی ایڈاپٹر برقرار رکھیں۔
- کنفیگ `gateway.http.endpoints.responses.enabled` شامل کریں (بطورِ طے شدہ `false`)۔
- `gateway.http.endpoints.chatCompletions.enabled` کو آزاد رکھیں؛ دونوں اینڈپوائنٹس کو
  علیحدہ طور پر ٹوگل کرنے کی اجازت دیں۔
- جب Chat Completions فعال ہو تو اسٹارٹ اپ وارننگ جاری کریں تاکہ لیگیسی حیثیت کا اشارہ ملے۔

## Chat Completions کے لیے فرسودگی کا راستہ

- سخت ماڈیول حدود برقرار رکھیں: responses اور chat completions کے درمیان مشترکہ اسکیما ٹائپس نہ ہوں۔
- Chat Completions کو کنفیگ کے ذریعے آپٹ اِن بنائیں تاکہ کوڈ تبدیلی کے بغیر غیر فعال کیا جا سکے۔
- جب `/v1/responses` مستحکم ہو جائے تو دستاویزات کو اپ ڈیٹ کر کے Chat Completions کو لیگیسی کے طور پر لیبل کریں۔
- اختیاری مستقبل قدم: آسان ہٹانے کے راستے کے لیے Chat Completions کی درخواستوں کو Responses ہینڈلر سے میپ کرنا۔

## مرحلہ 1 کی معاونت کا ذیلی مجموعہ

- `input` کو اسٹرنگ یا `ItemParam[]` کے طور پر قبول کریں جس میں میسج رولز اور `function_call_output` ہوں۔
- سسٹم اور ڈیولپر پیغامات کو `extraSystemPrompt` میں اخذ کریں۔
- ایجنٹ رنز کے لیے حالیہ ترین `user` یا `function_call_output` کو موجودہ پیغام کے طور پر استعمال کریں۔
- غیر معاون مواد حصوں (تصویر/فائل) کو `invalid_request_error` کے ساتھ مسترد کریں۔
- `output_text` مواد کے ساتھ ایک واحد اسسٹنٹ پیغام واپس کریں۔
- ٹوکن اکاؤنٹنگ وائر ہونے تک صفر شدہ اقدار کے ساتھ `usage` واپس کریں۔

## توثیقی حکمتِ عملی (کوئی SDK نہیں)

- معاون ذیلی مجموعے کے لیے Zod اسکیماز نافذ کریں:
  - `CreateResponseBody`
  - `ItemParam` + پیغام کے مواد کے حصوں کی یونینز
  - `ResponseResource`
  - Gateway کے ذریعے استعمال ہونے والی اسٹریمنگ ایونٹ شیپس
- اسکیماز کو ایک واحد، علیحدہ ماڈیول میں رکھیں تاکہ ڈرفٹ سے بچا جا سکے اور مستقبل کی کوڈ جنریشن ممکن ہو۔

## اسٹریمنگ نفاذ (مرحلہ 1)

- SSE لائنز جن میں `event:` اور `data:` دونوں شامل ہوں۔
- لازمی ترتیب (کم از کم قابلِ عمل):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (ضرورت کے مطابق دہرائیں)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## ٹیسٹس اور توثیق کا منصوبہ

- `/v1/responses` کے لیے e2e کوریج شامل کریں:
  - تصدیق درکار
  - نان اسٹریِم ریسپانس کی ساخت
  - اسٹریِم ایونٹ آرڈرنگ اور `[DONE]`
  - ہیڈرز اور `user` کے ساتھ سیشن روٹنگ
- `src/gateway/openai-http.e2e.test.ts` کو بغیر تبدیلی کے رکھیں۔
- دستی: curl کے ذریعے `/v1/responses` پر `stream: true` کے ساتھ کال کریں اور ایونٹ آرڈرنگ اور آخری
  `[DONE]` کی تصدیق کریں۔

## دستاویزاتی اپ ڈیٹس (فالو اَپ)

- `/v1/responses` کے استعمال اور مثالوں کے لیے ایک نیا ڈاکس صفحہ شامل کریں۔
- `/gateway/openai-http-api` کو لیگیسی نوٹ اور `/v1/responses` کی طرف اشارے کے ساتھ اپ ڈیٹ کریں۔
