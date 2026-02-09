---
summary: "Настройка бота Mattermost и конфигурация OpenClaw"
read_when:
  - Настройка Mattermost
  - Отладка маршрутизации Mattermost
title: "Mattermost"
---

# Mattermost (плагин)

Статус: поддерживается через плагин (токен бота + события WebSocket). Поддерживаются каналы, группы и личные сообщения.
Mattermost — это самохостируемая платформа командных сообщений; сведения о продукте и загрузках см. на официальном сайте
[mattermost.com](https://mattermost.com).

## Требуется плагин

Mattermost поставляется как плагин и не входит в состав основной установки.

Установка через CLI (реестр npm):

```bash
openclaw plugins install @openclaw/mattermost
```

Локальный checkout (при запуске из git-репозитория):

```bash
openclaw plugins install ./extensions/mattermost
```

Если во время конфигурации/онбординга выбрать Mattermost и будет обнаружен git checkout,
OpenClaw автоматически предложит путь локальной установки.

Подробности: [Plugins](/tools/plugin)

## Quick setup

1. Установите плагин Mattermost.
2. Создайте учётную запись бота Mattermost и скопируйте **токен бота**.
3. Скопируйте **base URL** Mattermost (например, `https://chat.example.com`).
4. Сконфигурируйте OpenClaw и запустите Gateway (шлюз).

Минимальный конфиг:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## Переменные окружения (учётная запись по умолчанию)

Задайте их на хосте шлюза Gateway, если предпочитаете переменные окружения:

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

Переменные окружения применяются только к **учётной записи по умолчанию** (`default`). Для других учётных записей необходимо использовать значения в конфиге.

## Режимы чата

Mattermost автоматически отвечает в личных сообщениях. Поведение в каналах управляется параметром `chatmode`:

- `oncall` (по умолчанию): отвечать только при @упоминании в каналах.
- `onmessage`: отвечать на каждое сообщение в канале.
- `onchar`: отвечать, когда сообщение начинается с триггерного префикса.

Пример конфига:

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

Примечания:

- `onchar` по‑прежнему отвечает на явные @упоминания.
- `channels.mattermost.requireMention` учитывается для устаревших конфигов, но предпочтительно использовать `chatmode`.

## Контроль доступа (личные сообщения)

- По умолчанию: `channels.mattermost.dmPolicy = "pairing"` (неизвестные отправители получают код сопряжения).
- Подтверждение через:
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- Публичные личные сообщения: `channels.mattermost.dmPolicy="open"` плюс `channels.mattermost.allowFrom=["*"]`.

## Каналы (группы)

- По умолчанию: `channels.mattermost.groupPolicy = "allowlist"` (требуется упоминание).
- Разрешённые отправители через список разрешённых `channels.mattermost.groupAllowFrom` (ID пользователей или `@username`).
- Открытые каналы: `channels.mattermost.groupPolicy="open"` (требуется упоминание).

## Цели для исходящей доставки

Используйте эти форматы целей с `openclaw message send` или cron/вебхуками:

- `channel:<id>` для канала
- `user:<id>` для личного сообщения
- `@username` для личного сообщения (разрешается через API Mattermost)

Голые ID трактуются как каналы.

## Несколько учётных записей

Mattermost поддерживает несколько учётных записей под `channels.mattermost.accounts`:

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## Устранение неполадок

- Нет ответов в каналах: убедитесь, что бот добавлен в канал и его упоминают (oncall), используйте триггерный префикс (onchar) или задайте `chatmode: "onmessage"`.
- Ошибки аутентификации: проверьте токен бота, base URL и включена ли учётная запись.
- Проблемы с несколькими учётными записями: переменные окружения применяются только к учётной записи `default`.
