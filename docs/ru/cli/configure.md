---
summary: "Справка CLI для `openclaw configure` (интерактивные запросы конфигурации)"
read_when:
  - Вам нужно интерактивно настроить учётные данные, устройства или параметры агента по умолчанию
title: "configure"
---

# `openclaw configure`

Интерактивный мастер для настройки учётных данных, устройств и параметров агента по умолчанию.

Примечание: Раздел **Model** теперь включает множественный выбор для allowlist `agents.defaults.models` (что отображается в `/model` и в выборе модели).

Совет: `openclaw config` без подкоманды открывает тот же мастер. Используйте
`openclaw config get|set|unset` для неинтерактивных правок.

Связанное:

- Справочник по конфигурации Gateway (шлюз): [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Примечания:

- Выбор места, где работает Gateway (шлюз), всегда обновляет `gateway.mode`. Вы можете выбрать «Continue», не заполняя другие разделы, если это всё, что вам нужно.
- Сервисы, ориентированные на каналы (Slack/Discord/Matrix/Microsoft Teams), во время настройки запрашивают allowlist каналов/комнат. Можно вводить имена или ID; мастер по возможности сопоставляет имена с ID.

## Примеры

```bash
openclaw configure
openclaw configure --section models --section channels
```
