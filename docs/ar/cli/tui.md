---
summary: "مرجع CLI للأمر `openclaw tui` (واجهة مستخدم طرفية متصلة بـ Gateway «البوابة»)"
read_when:
  - تريد واجهة مستخدم طرفية لـ Gateway «البوابة» (ملائمة للاستخدام عن بُعد)
  - تريد تمرير url/‏token/‏session من السكربتات
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:48:03Z
---

# `openclaw tui`

افتح واجهة المستخدم الطرفية المتصلة بـ Gateway «البوابة».

ذات صلة:

- دليل TUI: [TUI](/web/tui)

## أمثلة

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
