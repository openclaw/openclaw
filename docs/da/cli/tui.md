---
summary: "CLI-reference for `openclaw tui` (terminal-UI forbundet til Gateway)"
read_when:
  - Du vil have en terminal-UI til Gateway (fjernvenlig)
  - Du vil sende url/token/session fra scripts
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:49:59Z
---

# `openclaw tui`

Åbn terminal-UI'en, der er forbundet til Gateway.

Relateret:

- TUI-guide: [TUI](/web/tui)

## Eksempler

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
