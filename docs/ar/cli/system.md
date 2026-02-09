---
summary: "مرجع CLI لأمر `openclaw system` (أحداث النظام، نبضات القلب، الحضور)"
read_when:
  - تريد إدراج حدث نظام دون إنشاء مهمة cron
  - تحتاج إلى تمكين أو تعطيل نبضات القلب
  - تريد فحص إدخالات حضور النظام
title: "system"
---

# `openclaw system`

مساعدات على مستوى النظام لـ Gateway: إدراج أحداث النظام في الطابور، التحكم في نبضات القلب،
وعرض الحضور.

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

إدراج حدث نظام على الجلسة **الرئيسية**. ستقوم نبضة القلب التالية بحقنه
كسطر `System:` في الموجّه. استخدم `--mode now` لتشغيل نبضة القلب
فورًا؛ بينما ينتظر `next-heartbeat` حتى النبضة المجدولة التالية.

Flags:

- `--text <text>`: نص حدث النظام المطلوب.
- `--mode <mode>`: `now` أو `next-heartbeat` (الافتراضي).
- `--json`: مخرجات قابلة للقراءة آليًا.

## `system heartbeat last|enable|disable`

عناصر التحكم في نبضات القلب:

- `last`: عرض آخر حدث لنبضة القلب.
- `enable`: إعادة تشغيل نبضات القلب (استخدم هذا إذا كانت معطّلة).
- `disable`: إيقاف نبضات القلب مؤقتًا.

Flags:

- `--json`: مخرجات قابلة للقراءة آليًا.

## `system presence`

سرد إدخالات حضور النظام الحالية التي يعرفها Gateway (العُقد،
والنُسخ، وأسطر الحالة المشابهة).

Flags:

- `--json`: مخرجات قابلة للقراءة آليًا.

## ملاحظات

- يتطلب Gateway قيد التشغيل ويمكن الوصول إليه عبر التهيئة الحالية لديك (محليًا أو عن بُعد).
- أحداث النظام مؤقتة ولا يتم حفظها عبر عمليات إعادة التشغيل.
