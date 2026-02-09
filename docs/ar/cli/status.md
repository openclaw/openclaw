---
summary: "مرجع CLI للأمر `openclaw status` (التشخيص، المجسّات، لقطات الاستخدام)"
read_when:
  - تريد تشخيصًا سريعًا لصحة القنوات + مستلمي الجلسات الأخيرة
  - تريد وضع "جميع" قابل للصق لتصحيح الأخطاء
title: "الحالة"
---

# `openclaw status`

تشخيصات القنوات + الجلسات.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

ملاحظات:

- `--deep` يُشغِّل مجسّات مباشرة (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- يتضمن الإخراج مخازن جلسات لكل وكيل عند تهيئة عدة وكلاء.
- تتضمن النظرة العامة حالة تثبيت/تشغيل خدمة Gateway + خدمة مضيف العُقدة عند توفرها.
- تتضمن النظرة العامة قناة التحديث + قيمة git SHA (للتحقّق من نُسخ المصدر).
- تظهر معلومات التحديث في النظرة العامة؛ وإذا كان هناك تحديث متاح، تطبع الحالة تلميحًا لتشغيل `openclaw update` (انظر [التحديث](/install/updating)).
