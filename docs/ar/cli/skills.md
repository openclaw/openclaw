---
summary: "مرجع CLI لأمر `openclaw skills` (list/info/check) وأهلية Skills"
read_when:
  - تريد معرفة Skills المتاحة والجاهزة للتشغيل
  - تريد تصحيح أخطاء الملفات التنفيذية أو متغيرات البيئة أو التهيئة المفقودة الخاصة بـ Skills
title: "skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:01Z
---

# `openclaw skills`

افحص Skills (المضمّنة + مساحة العمل + التجاوزات المُدارة) واطّلع على ما هو مؤهَّل مقابل ما يفتقد المتطلبات.

ذات صلة:

- نظام Skills: [Skills](/tools/skills)
- تهيئة Skills: [Skills config](/tools/skills-config)
- تثبيتات ClawHub: [ClawHub](/tools/clawhub)

## Commands

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
