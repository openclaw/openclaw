---
summary: "Справка по CLI для `openclaw directory` (self, peers, groups)"
read_when:
  - Вы хотите найти идентификаторы контактов/групп/себя для канала
  - Вы разрабатываете адаптер каталога канала
title: "directory"
---

# `openclaw directory`

Поиск по каталогам для каналов, которые это поддерживают (контакты/пиры, группы и «я»).

## Common flags

- `--channel <name>`: идентификатор/алиас канала (обязательно, когда настроено несколько каналов; автоматически, если настроен только один)
- `--account <id>`: идентификатор аккаунта (по умолчанию: значение по умолчанию канала)
- `--json`: вывод в формате JSON

## Notes

- `directory` предназначен для того, чтобы помочь вам найти идентификаторы, которые можно вставлять в другие команды (особенно `openclaw message send --target ...`).
- Для многих каналов результаты берутся из конфига (списки разрешённых / настроенные группы), а не из живого каталога провайдера.
- Вывод по умолчанию — `id` (и иногда `name`), разделённые табуляцией; используйте `--json` для скриптов.

## Using results with `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567` (DM), `1234567890-1234567890@g.us` (группа)
- Telegram: `@username` или числовой идентификатор чата; группы — числовые идентификаторы
- Slack: `user:U…` и `channel:C…`
- Discord: `user:<id>` и `channel:<id>`
- Matrix (плагин): `user:@user:server`, `room:!roomId:server` или `#alias:server`
- Microsoft Teams (плагин): `user:<id>` и `conversation:<id>`
- Zalo (плагин): идентификатор пользователя (Bot API)
- Zalo Personal / `zalouser` (плагин): идентификатор треда (DM/группа) из `zca` (`me`, `friend list`, `group list`)

## Self («me»)

```bash
openclaw directory self --channel zalouser
```

## Peers (contacts/users)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
