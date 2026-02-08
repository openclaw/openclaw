---
summary: "Справка по CLI для `openclaw tui` (терминальный интерфейс, подключённый к Gateway (шлюзу))"
read_when:
  - Вам нужен терминальный интерфейс для Gateway (шлюза) (подходит для удалённой работы)
  - Вам нужно передавать url/токен/сеанс из скриптов
title: "tui"
x-i18n:
  source_path: cli/tui.md
  source_hash: aa6f37b960926997
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:18Z
---

# `openclaw tui`

Открывает терминальный интерфейс, подключённый к Gateway (шлюзу).

Связанное:

- Руководство по TUI: [TUI](/web/tui)

## Примеры

```bash
openclaw tui
openclaw tui --url ws://127.0.0.1:18789 --token <token>
openclaw tui --session main --deliver
```
