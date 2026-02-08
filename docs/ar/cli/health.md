---
summary: "مرجع CLI لأمر `openclaw health` (نقطة نهاية صحة Gateway عبر RPC)"
read_when:
  - "تريد التحقق بسرعة من صحة Gateway قيد التشغيل"
title: "الصحة"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:00Z
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
