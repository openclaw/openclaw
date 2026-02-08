---
summary: "كيف يدمج تطبيق mac واجهة WebChat الخاصة بـ Gateway وكيفية تصحيح أخطائها"
read_when:
  - تصحيح عرض WebChat على mac أو منفذ local loopback
title: "WebChat"
x-i18n:
  source_path: platforms/mac/webchat.md
  source_hash: 7c425374673b817a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:30Z
---

# WebChat (تطبيق macOS)

يقوم تطبيق شريط القوائم في macOS بتضمين واجهة WebChat كعرض SwiftUI أصلي. ويتصل بـ Gateway ويستخدم افتراضيًا **الجلسة الرئيسية** للوكيل المحدد (مع مُبدّل جلسات للجلسات الأخرى).

- **الوضع المحلي**: يتصل مباشرةً بـ WebSocket الخاص بـ Gateway المحلي.
- **الوضع البعيد**: يمرّر منفذ تحكم Gateway عبر SSH ويستخدم هذا النفق كطبقة البيانات.

## التشغيل وتصحيح الأخطاء

- يدويًا: قائمة Lobster → «فتح الدردشة».
- الفتح التلقائي للاختبار:

  ```bash
  dist/OpenClaw.app/Contents/MacOS/OpenClaw --webchat
  ```

- السجلات: `./scripts/clawlog.sh` (النظام الفرعي `bot.molt`، الفئة `WebChatSwiftUI`).

## كيفية التوصيل

- طبقة البيانات: أساليب Gateway عبر WS ‏`chat.history`، `chat.send`، `chat.abort`،
  `chat.inject` والأحداث `chat`، `agent`، `presence`، `tick`، `health`.
- الجلسة: افتراضيًا الجلسة الأساسية (`main`، أو `global` عندما يكون النطاق
  عامًا). يمكن لواجهة المستخدم التبديل بين الجلسات.
- تستخدم التهيئة الأولية جلسة مخصصة للحفاظ على إعداد التشغيل الأول منفصلًا.

## السطح الأمني

- في الوضع البعيد، يتم تمرير منفذ تحكم WebSocket الخاص بـ Gateway فقط عبر SSH.

## القيود المعروفة

- تم تحسين واجهة المستخدم لجلسات الدردشة (وليست sandbox كاملة للمتصفح).
