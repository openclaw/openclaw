---
summary: "Справочник CLI для `openclaw voicecall` (поверхность команд плагина voice-call)"
read_when:
  - Вы используете плагин voice-call и хотите точки входа CLI
  - Вам нужны быстрые примеры для `voicecall call|continue|status|tail|expose`
title: "voicecall"
---

# `openclaw voicecall`

`voicecall` — это команда, предоставляемая плагином. Она появляется только если плагин voice-call установлен и включён.

Основная документация:

- Плагин voice-call: [Voice Call](/plugins/voice-call)

## Часто используемые команды

```bash
openclaw voicecall status --call-id <id>
openclaw voicecall call --to "+15555550123" --message "Hello" --mode notify
openclaw voicecall continue --call-id <id> --message "Any questions?"
openclaw voicecall end --call-id <id>
```

## Выделение вебхуков (хвостовая шкала)

```bash
openclaw voicecall expose --mode serve
openclaw voicecall expose --mode funnel
openclaw voicecall unexpose
```

Примечание по безопасности: публикуйте конечную точку вебхука только в сетях, которым вы доверяете. По возможности предпочитайте Tailscale Serve вместо Funnel.
