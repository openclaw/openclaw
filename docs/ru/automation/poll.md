---
summary: "Отправка опросов через Gateway (шлюз) и CLI"
read_when:
  - Добавление или изменение поддержки опросов
  - Отладка отправки опросов из CLI или через Gateway (шлюз)
title: "Опросы"
---

# Опросы

## Поддерживаемые каналы

- WhatsApp (веб-канал)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Параметры:

- `--channel`: `whatsapp` (по умолчанию), `discord` или `msteams`
- `--poll-multi`: разрешить выбор нескольких вариантов
- `--poll-duration-hours`: только для Discord (по умолчанию 24, если не указано)

## Gateway RPC

Метод: `poll`

Params:

- `to` (string, обязательно)
- `question` (string, обязательно)
- `options` (string[], обязательно)
- `maxSelections` (number, необязательно)
- `durationHours` (number, необязательно)
- `channel` (string, необязательно, по умолчанию: `whatsapp`)
- `idempotencyKey` (string, обязательно)

## Различия между каналами

- WhatsApp: 2–12 вариантов, `maxSelections` должен находиться в пределах количества вариантов, `durationHours` игнорируется.
- Discord: 2–10 вариантов, `durationHours` ограничивается диапазоном 1–768 часов (по умолчанию 24). `maxSelections > 1` включает множественный выбор; Discord не поддерживает строгий лимит количества выбираемых вариантов.
- MS Teams: опросы через Adaptive Card (под управлением OpenClaw). Нативного API для опросов нет; `durationHours` игнорируется.

## Инструмент агента (Message)

Используйте инструмент `message` с действием `poll` (`to`, `pollQuestion`, `pollOption`, необязательные `pollMulti`, `pollDurationHours`, `channel`).

Примечание: в Discord отсутствует режим «выбрать ровно N»; `pollMulti` сопоставляется с множественным выбором.
Опросы в Teams отображаются как Adaptive Cards и требуют, чтобы Gateway (шлюз) оставался онлайн
для записи голосов в `~/.openclaw/msteams-polls.json`.
