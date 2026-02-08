---
summary: "مرجع CLI لأمر `openclaw pairing` (الموافقة على طلبات الاقتران أو عرضها)"
read_when:
  - "تستخدم الرسائل المباشرة بوضع الاقتران وتحتاج إلى الموافقة على المُرسِلين"
title: "الاقتران"
x-i18n:
  source_path: cli/pairing.md
  source_hash: 785869d24d953141
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:01Z
---

# `openclaw pairing`

الموافقة على طلبات اقتران الرسائل المباشرة أو فحصها (للقنوات التي تدعم الاقتران).

ذات صلة:

- تدفّق الاقتران: [الاقتران](/channels/pairing)

## الأوامر

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code> --notify
```
