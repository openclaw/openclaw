---
summary: "CLI-Referenz für `openclaw tui` (Terminal-UI, die mit dem Gateway verbunden ist)"
read_when:
  - Sie möchten eine Terminal-UI für das Gateway (remote-tauglich)
  - Sie möchten URL/Token/Sitzung aus Skripten übergeben
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:44Z
---

# `openclaw tui`

Öffnet die Terminal-UI, die mit dem Gateway verbunden ist.

Verwandt:

- TUI-Leitfaden: [TUI](/web/tui)

## Beispiele

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
