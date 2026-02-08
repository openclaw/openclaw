---
summary: "CLI حوالہ برائے `openclaw logs` (RPC کے ذریعے Gateway لاگز کی ٹیلنگ)"
read_when:
  - آپ کو Gateway لاگز کو ریموٹ طور پر ٹیل کرنا ہو (SSH کے بغیر)
  - آپ ٹولنگ کے لیے JSON لاگ لائنیں چاہتے ہوں
title: "لاگز"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:57Z
---

# `openclaw logs`

RPC کے ذریعے Gateway فائل لاگز کی ٹیلنگ کریں (ریموٹ موڈ میں کام کرتا ہے)۔

متعلقہ:

- لاگنگ کا جائزہ: [Logging](/logging)

## مثالیں

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
