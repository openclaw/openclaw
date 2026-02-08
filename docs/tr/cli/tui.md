---
summary: "Gateway’e bağlı `openclaw tui` için CLI başvurusu (terminal UI)"
read_when:
  - Gateway için bir terminal UI istiyorsanız (uzaktan kullanıma uygun)
  - Betiklerden URL/belirteç/oturum geçirmek istiyorsanız
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:53:05Z
---

# `openclaw tui`

Gateway’e bağlı terminal UI’yi açar.

İlgili:

- TUI kılavuzu: [TUI](/web/tui)

## Örnekler

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
