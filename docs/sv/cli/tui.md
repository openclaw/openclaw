---
summary: "CLI-referens för `openclaw tui` (terminal-UI ansluten till Gateway)"
read_when:
  - Du vill ha ett terminal-UI för Gateway (fjärrvänligt)
  - Du vill skicka url/token/session från skript
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:16:46Z
---

# `openclaw tui`

Öppna terminal-UI:t som är anslutet till Gateway.

Relaterat:

- TUI-guide: [TUI](/web/tui)

## Exempel

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
