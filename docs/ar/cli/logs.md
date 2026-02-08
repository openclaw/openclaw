---
summary: "مرجع CLI لأمر `openclaw logs` (تتبّع سجلات Gateway عبر RPC)"
read_when:
  - تحتاج إلى تتبّع سجلات Gateway عن بُعد (من دون SSH)
  - تريد أسطر سجلات بصيغة JSON لأدوات الأتمتة
title: "السجلات"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:58Z
---

# `openclaw logs`

تتبّع سجلات ملفات Gateway عبر RPC (يعمل في الوضع البعيد).

ذات صلة:

- نظرة عامة على التسجيل: [التسجيل](/logging)

## أمثلة

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
