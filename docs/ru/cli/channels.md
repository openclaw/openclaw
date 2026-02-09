---
summary: "Справка CLI для `openclaw channels` (аккаунты, статус, вход/выход, логи)"
read_when:
  - Вам нужно добавить/удалить аккаунты каналов (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (плагин)/Signal/iMessage)
  - Вам нужно проверить статус канала или просмотреть логи канала в режиме tail
title: "channels"
---

# `openclaw channels`

Управление аккаунтами чатов и их состоянием выполнения на Gateway (шлюзе).

Связанная документация:

- Руководства по каналам: [Channels](/channels/index)
- Конфигурация Gateway (шлюза): [Configuration](/gateway/configuration)

## Часто используемые команды

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Добавление / удаление аккаунтов

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Совет: `openclaw channels add --help` показывает флаги для каждого канала (токен, app token, пути signal-cli и т. д.).

## Вход / выход (интерактивно)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Устранение неполадок

- Запустите `openclaw status --deep` для общего зондирования.
- Используйте `openclaw doctor` для пошаговых исправлений.
- `openclaw channels list` выводит `Claude: HTTP 403 ... user:profile` → для снимка использования требуется область доступа `user:profile`. Используйте `--no-usage`, либо укажите ключ сеанса claude.ai (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), либо повторно выполните аутентификацию через Claude Code CLI.

## Зондирование возможностей

Получение подсказок о возможностях провайдера (intents/области доступа, где доступны), а также статической поддержки функций:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Примечания:

- `--channel` необязательно; опустите его, чтобы вывести все каналы (включая расширения).
- `--target` принимает `channel:<id>` или «сырой» числовой идентификатор канала и применяется только к Discord.
- Зондирование специфично для провайдера: intents Discord + необязательные права доступа к каналам; области доступа бота и пользователя Slack; флаги бота Telegram + webhook; версия демона Signal; токен приложения MS Teams + роли/области Graph (с аннотациями, где известно). Каналы без зондирования сообщают `Probe: unavailable`.

## Разрешение имён в идентификаторы

Разрешение имён каналов/пользователей в идентификаторы с использованием каталога провайдера:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Примечания:

- Используйте `--kind user|group|auto`, чтобы принудительно задать тип цели.
- При разрешении предпочтение отдаётся активным совпадениям, если несколько записей имеют одно и то же имя.
