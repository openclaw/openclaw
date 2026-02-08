---
summary: "Sanggunian ng CLI para sa `openclaw tui` (terminal UI na konektado sa Gateway)"
read_when:
  - Gusto mo ng terminal UI para sa Gateway (madaling gamitin nang remote)
  - Gusto mong magpasa ng url/token/session mula sa mga script
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:15Z
---

# `openclaw tui`

Buksan ang terminal UI na konektado sa Gateway.

Kaugnay:

- Gabay sa TUI: [TUI](/web/tui)

## Mga halimbawa

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
