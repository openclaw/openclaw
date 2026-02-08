---
summary: "Gateway (گیٹ وے) سے منسلک ٹرمینل UI کے لیے `openclaw tui` کی CLI حوالہ جاتی دستاویز"
read_when:
  - آپ Gateway (گیٹ وے) کے لیے ایک ٹرمینل UI چاہتے ہیں (ریمورٹ کے لیے موزوں)
  - آپ اسکرپٹس سے url/token/session پاس کرنا چاہتے ہیں
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:47:05Z
---

# `openclaw tui`

Gateway (گیٹ وے) سے منسلک ٹرمینل UI کھولیں۔

متعلقہ:

- TUI گائیڈ: [TUI](/web/tui)

## مثالیں

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
