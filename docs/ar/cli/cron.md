---
summary: "مرجع CLI للأمر `openclaw cron` (جدولة وتشغيل المهام في الخلفية)"
read_when:
  - تريد مهام مجدولة وإيقاظات
  - تقوم بتصحيح تنفيذ cron والسجلات
title: "cron"
---

# `openclaw cron`

إدارة مهام cron لمُجدول Gateway (البوابة).

ذات صلة:

- مهام cron: [Cron jobs](/automation/cron-jobs)

نصيحة: شغّل `openclaw cron --help` للاطّلاع على السطح الكامل للأوامر.

ملاحظة: المهام المعزولة `cron add` يكون تسليمها افتراضيًا `--announce`. استخدم `--no-deliver` للإبقاء على
المخرجات داخلية. يبقى `--deliver` كاسم مستعار مُهمَل لـ `--announce`.

ملاحظة: المهام أحادية التشغيل (`--at`) تُحذف افتراضيًا بعد النجاح. استخدم `--keep-after-run` للاحتفاظ بها.

ملاحظة: تستخدم المهام المتكررة الآن تراجعًا أسيًا لإعادة المحاولة بعد أخطاء متتالية (30 ثانية → دقيقة واحدة → 5 دقائق → 15 دقيقة → 60 دقيقة)، ثم تعود إلى الجدول الطبيعي بعد أول تشغيل ناجح تالٍ.

## تعديلات شائعة

تحديث إعدادات التسليم دون تغيير الرسالة:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

تعطيل التسليم لمهمة معزولة:

```bash
openclaw cron edit <job-id> --no-deliver
```

الإعلان إلى قناة محددة:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
