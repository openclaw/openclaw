---
summary: "مرجع CLI لأمر `openclaw logs` (تتبّع سجلات Gateway عبر RPC)"
read_when:
  - تحتاج إلى تتبّع سجلات Gateway عن بُعد (من دون SSH)
  - تريد أسطر سجلات بصيغة JSON لأدوات الأتمتة
title: "السجلات"
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
