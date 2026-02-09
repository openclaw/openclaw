---
summary: "Статус поддержки Tlon/Urbit, возможности и конфигурация"
read_when:
  - Работа над возможностями канала Tlon/Urbit
title: "Tlon"
---

# Tlon (плагин)

Tlon — это децентрализованный мессенджер, построенный на Urbit. OpenClaw подключается к вашему кораблю Urbit и может
отвечать на личные сообщения и сообщения в групповых чатах. Ответы в группах по умолчанию требуют упоминания @ и могут
быть дополнительно ограничены через списки разрешённых.

Статус: поддерживается через плагин. Поддерживаются личные сообщения, упоминания в группах, ответы в тредах и резервный
режим для текстовых сообщений с медиа (URL добавляется к подписи). Реакции, опросы и нативная загрузка медиа не
поддерживаются.

## Требуется плагин

Tlon поставляется как плагин и не входит в состав основной установки.

Установка через CLI (реестр npm):

```bash
openclaw plugins install @openclaw/tlon
```

Локальная установка (при запуске из git-репозитория):

```bash
openclaw plugins install ./extensions/tlon
```

Подробности: [Plugins](/tools/plugin)

## Настройка

1. Установите плагин Tlon.
2. Подготовьте URL вашего корабля и код входа.
3. Настройте `channels.tlon`.
4. Перезапустите Gateway (шлюз).
5. Отправьте боту личное сообщение или упомяните его в групповом канале.

Минимальный конфиг (одна учётная запись):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Групповые каналы

Автообнаружение включено по умолчанию. Также можно закрепить каналы вручную:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Отключение автообнаружения:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Контроль доступа

Список разрешённых для личных сообщений (пусто = разрешены все):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Авторизация для групп (по умолчанию ограничено):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Цели доставки (CLI/cron)

Используйте их с `openclaw message send` или доставкой через cron:

- Личные сообщения: `~sampel-palnet` или `dm/~sampel-palnet`
- Группы: `chat/~host-ship/channel` или `group:~host-ship/channel`

## Примечания

- Ответы в группах требуют упоминания (например, `~your-bot-ship`).
- Ответы в тредах: если входящее сообщение находится в треде, OpenClaw отвечает в этом же треде.
- Медиа: `sendMedia` использует резервный режим «текст + URL» (без нативной загрузки).
