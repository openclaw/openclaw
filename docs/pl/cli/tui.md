---
summary: "Dokumentacja referencyjna CLI dla `openclaw tui` (terminalny interfejs użytkownika połączony z Gateway)"
read_when:
  - Chcesz terminalny interfejs użytkownika dla Gateway (przyjazny dla pracy zdalnej)
  - Chcesz przekazywać url/token/sesję ze skryptów
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:58Z
---

# `openclaw tui`

Otwiera terminalny interfejs użytkownika połączony z Gateway.

Powiązane:

- Przewodnik TUI: [TUI](/web/tui)

## Przykłady

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
