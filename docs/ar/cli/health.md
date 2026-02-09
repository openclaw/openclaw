---
summary: "مرجع CLI لأمر `openclaw health` (نقطة نهاية صحة Gateway عبر RPC)"
read_when:
  - تريد التحقق بسرعة من صحة Gateway قيد التشغيل
title: "الصحة"
---

# `openclaw health`

جلب حالة الصحة من Gateway قيد التشغيل.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

ملاحظات:

- `--verbose` يشغّل مجسّات مباشرة ويطبع أزمنة لكل حساب عند تهيئة عدة حسابات.
- يتضمن الإخراج مخازن الجلسات لكل وكيل عند تهيئة عدة وكلاء.
