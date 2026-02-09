---
summary: "Справка по CLI для `openclaw tui` (терминальный интерфейс, подключённый к Gateway (шлюзу))"
read_when:
  - Вам нужен терминальный интерфейс для Gateway (шлюза) (подходит для удалённой работы)
  - Вам нужно передавать url/токен/сеанс из скриптов
title: "tui"
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
