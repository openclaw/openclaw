---
summary: "مرجع CLI للأمر `openclaw setup` (تهيئة الإعداد + مساحة عمل الوكيل)"
read_when:
  - "تقوم بإعداد التشغيل الأول دون استخدام معالج التهيئة الأولية الكامل"
  - "ترغب في تعيين المسار الافتراضي لمساحة العمل"
title: "الإعداد"
x-i18n:
  source_path: cli/setup.md
  source_hash: 7f3fc8b246924edf
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:03Z
---

# `openclaw setup`

تهيئة `~/.openclaw/openclaw.json` ومساحة عمل الوكيل.

ذات صلة:

- بدء الاستخدام: [بدء الاستخدام](/start/getting-started)
- المعالج: [التهيئة الأولية](/start/onboarding)

## أمثلة

```bash
openclaw setup
openclaw setup --workspace ~/.openclaw/workspace
```

لتشغيل المعالج عبر setup:

```bash
openclaw setup --wizard
```
