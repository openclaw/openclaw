---
summary: "Справка по CLI для `openclaw agent` (отправка одного хода агента через Gateway (шлюз))"
read_when:
  - Вам нужно запустить один ход агента из скриптов (при необходимости доставить ответ)
title: "agent"
---

# `openclaw agent`

Запуск одного хода агента через Gateway (шлюз) (для встраивания используйте `--local`).
Используйте `--agent <id>`, чтобы нацелиться непосредственно на настроенного агента.

Связанное:

- Инструмент отправки агента: [Agent send](/tools/agent-send)

## Примеры

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
