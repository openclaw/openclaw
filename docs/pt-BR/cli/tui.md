---
summary: "Referência da CLI para `openclaw tui` (UI de terminal conectada ao Gateway)"
read_when:
  - Você quer uma UI de terminal para o Gateway (amigável para acesso remoto)
  - Você quer passar url/token/sessão a partir de scripts
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:26Z
---

# `openclaw tui`

Abra a UI de terminal conectada ao Gateway.

Relacionado:

- Guia do TUI: [TUI](/web/tui)

## Exemplos

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
