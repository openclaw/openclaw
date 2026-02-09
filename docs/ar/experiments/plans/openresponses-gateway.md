---
summary: "خطة: إضافة نقطة نهاية OpenResponses ‎/v1/responses‎ وإيقاف Chat Completions بشكلٍ نظيف"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "خطة Gateway لـ OpenResponses"
---

# خطة تكامل OpenResponses Gateway

## السياق

يوفّر OpenClaw Gateway حاليًا نقطة نهاية بسيطة متوافقة مع OpenAI لـ Chat Completions عند
`/v1/chat/completions` (انظر [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses هو معيار استدلال مفتوح قائم على واجهة OpenAI Responses API. صُمّم لسير عملٍ وكيلِيّ
ويستخدم مُدخلات قائمة على العناصر إضافةً إلى أحداث بثّ دلالية. يحدّد مواصفات OpenResponses
`/v1/responses`، وليس `/v1/chat/completions`.

## الأهداف

- إضافة نقطة نهاية `/v1/responses` تلتزم بدلالات OpenResponses.
- الإبقاء على Chat Completions كطبقة توافق يسهل تعطيلها ثم إزالتها لاحقًا.
- توحيد التحقق والتحليل باستخدام مخططات معزولة وقابلة لإعادة الاستخدام.

## ما ليس ضمن الأهداف

- تحقيق تكافؤ كامل لميزات OpenResponses في المرحلة الأولى (الصور، الملفات، الأدوات المستضافة).
- استبدال منطق تنفيذ الوكلاء الداخلي أو تنسيق الأدوات.
- تغيير سلوك `/v1/chat/completions` الحالي خلال المرحلة الأولى.

## ملخص البحث

المصادر: OpenResponses OpenAPI، موقع مواصفات OpenResponses، ومنشور مدونة Hugging Face.

النقاط الرئيسية المستخلصة:

- `POST /v1/responses` يقبل حقول `CreateResponseBody` مثل `model`، و`input` (سلسلة نصية أو
  `ItemParam[]`)، و`instructions`، و`tools`، و`tool_choice`، و`stream`، و`max_output_tokens`، و
  `max_tool_calls`.
- `ItemParam` هو اتحاد مميَّز يتكوّن من:
  - عناصر `message` بأدوار `system`، و`developer`، و`user`، و`assistant`
  - `function_call` و`function_call_output`
  - `reasoning`
  - `item_reference`
- تعيد الاستجابات الناجحة `ResponseResource` مع عناصر `object: "response"` و`status` و
  `output`.
- يستخدم البث أحداثًا دلالية مثل:
  - `response.created`، و`response.in_progress`، و`response.completed`، و`response.failed`
  - `response.output_item.added`، و`response.output_item.done`
  - `response.content_part.added`، و`response.content_part.done`
  - `response.output_text.delta`، و`response.output_text.done`
- تتطلب المواصفات:
  - `Content-Type: text/event-stream`
  - يجب أن يطابق `event:` حقل JSON `type`
  - يجب أن يكون الحدث الختامي حرفيًا `[DONE]`
- قد تُظهر عناصر الاستدلال `content` و`encrypted_content` و`summary`.
- تتضمن أمثلة HF الحقل `OpenResponses-Version: latest` في الطلبات (رأس اختياري).

## البنية المقترحة

- إضافة `src/gateway/open-responses.schema.ts` يحتوي على مخططات Zod فقط (من دون استيرادات من Gateway).
- إضافة `src/gateway/openresponses-http.ts` (أو `open-responses-http.ts`) لـ `/v1/responses`.
- الإبقاء على `src/gateway/openai-http.ts` كما هو كمحوّل توافق قديم.
- إضافة إعداد `gateway.http.endpoints.responses.enabled` (القيمة الافتراضية `false`).
- الإبقاء على `gateway.http.endpoints.chatCompletions.enabled` مستقلاً؛ والسماح بتبديل كلتا نقطتي النهاية
  بشكلٍ منفصل.
- إصدار تحذير عند بدء التشغيل عندما تكون Chat Completions مُمكّنة للإشارة إلى حالتها القديمة.

## مسار إيقاف Chat Completions

- الحفاظ على حدود وحدات صارمة: لا أنواع مخططات مشتركة بين responses وchat completions.
- جعل Chat Completions خيارًا مُفعّلًا عبر الإعدادات بحيث يمكن تعطيله دون تغييرات في الشيفرة.
- تحديث الوثائق لوضع وسم «قديم» على Chat Completions حالما يستقر `/v1/responses`.
- خطوة مستقبلية اختيارية: ربط طلبات Chat Completions بمعالج Responses لتبسيط مسار الإزالة.

## مجموعة الدعم في المرحلة الأولى

- قبول `input` كسلسلة نصية أو `ItemParam[]` مع أدوار الرسائل و`function_call_output`.
- استخراج رسائل النظام والمطوّر إلى `extraSystemPrompt`.
- استخدام أحدث `user` أو `function_call_output` كرسالة حالية لتشغيل الوكيل.
- رفض أجزاء المحتوى غير المدعومة (صورة/ملف) مع `invalid_request_error`.
- إرجاع رسالة مساعد واحدة بمحتوى `output_text`.
- إرجاع `usage` بقيم مُصفّرة إلى أن يتم توصيل احتساب الرموز.

## استراتيجية التحقق (من دون SDK)

- تنفيذ مخططات Zod للمجموعة المدعومة من:
  - `CreateResponseBody`
  - `ItemParam` + اتحادات أجزاء محتوى الرسائل
  - `ResponseResource`
  - أشكال أحداث البث المستخدمة بواسطة Gateway
- الإبقاء على المخططات في وحدة واحدة ومعزولة لتجنّب الانحراف والسماح بتوليد الشيفرة مستقبلًا.

## تنفيذ البث (المرحلة الأولى)

- أسطر SSE مع كلٍّ من `event:` و`data:`.
- التسلسل المطلوب (الحد الأدنى القابل للتطبيق):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (يُكرَّر عند الحاجة)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## الاختبارات وخطة التحقق

- إضافة تغطية e2e لـ `/v1/responses`:
  - المصادقة مطلوبة
  - شكل الاستجابة غير المتدفقة
  - ترتيب أحداث البث و`[DONE]`
  - توجيه الجلسة باستخدام الرؤوس و`user`
- الإبقاء على `src/gateway/openai-http.e2e.test.ts` دون تغيير.
- يدويًا: استخدام curl إلى `/v1/responses` مع `stream: true` والتحقق من ترتيب الأحداث والحدث
  الختامي `[DONE]`.

## تحديثات الوثائق (لاحقًا)

- إضافة صفحة وثائق جديدة لاستخدام `/v1/responses` مع أمثلة.
- تحديث `/gateway/openai-http-api` بملاحظة «قديم» ومؤشر إلى `/v1/responses`.
