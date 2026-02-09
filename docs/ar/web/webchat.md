---
summary: "استضافة WebChat الثابتة عبر loopback واستخدام WebSocket الخاص بـ Gateway لواجهة الدردشة"
read_when:
  - عند تصحيح الأخطاء أو تهيئة الوصول إلى WebChat
title: "WebChat"
---

# WebChat (واجهة WebSocket الخاصة بـ Gateway)

الحالة: تتواصل واجهة الدردشة SwiftUI على macOS/iOS مباشرةً مع WebSocket الخاص بـ Gateway.

## ما هو

- واجهة دردشة أصلية للبوابة (من دون متصفح مضمّن ومن دون خادم ثابت محلي).
- تستخدم الجلسات نفسها وقواعد التوجيه نفسها مثل القنوات الأخرى.
- توجيه حتمي: تعود الردود دائمًا إلى WebChat.

## البدء السريع

1. شغّل Gateway.
2. افتح واجهة WebChat (تطبيق macOS/iOS) أو علامة تبويب الدردشة في واجهة التحكم.
3. تأكّد من تهيئة مصادقة Gateway (مطلوبة افتراضيًا، حتى على loopback).

## كيفية العمل (السلوك)

- تتصل الواجهة بـ WebSocket الخاص بـ Gateway وتستخدم `chat.history` و`chat.send` و`chat.inject`.
- يقوم `chat.inject` بإلحاق ملاحظة من المساعد مباشرةً بسجل المحادثة وبثّها إلى الواجهة (من دون تشغيل وكيل).
- يتم دائمًا جلب السجل من Gateway (لا توجد مراقبة لملفات محلية).
- إذا تعذّر الوصول إلى Gateway، يكون WebChat للقراءة فقط.

## الاستخدام عن بُعد

- يقوم الوضع البعيد بنفقنة WebSocket الخاص بـ Gateway عبر SSH/Tailscale.
- لا تحتاج إلى تشغيل خادم WebChat منفصل.

## مرجع التهيئة (WebChat)

التهيئة الكاملة: [Configuration](/gateway/configuration)

خيارات القناة:

- لا توجد كتلة `webchat.*` مخصّصة. يستخدم WebChat نقطة نهاية Gateway + إعدادات المصادقة أدناه.

الخيارات العامة ذات الصلة:

- `gateway.port` و`gateway.bind`: مضيف/منفذ WebSocket.
- `gateway.auth.mode` و`gateway.auth.token` و`gateway.auth.password`: مصادقة WebSocket.
- `gateway.remote.url` و`gateway.remote.token` و`gateway.remote.password`: هدف Gateway البعيد.
- `session.*`: تخزين الجلسات والإعدادات الافتراضية للمفتاح الرئيسي.
