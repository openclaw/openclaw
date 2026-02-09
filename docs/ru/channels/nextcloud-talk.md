---
summary: "Статус поддержки Nextcloud Talk, возможности и конфигурация"
read_when:
  - Работа над возможностями канала Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (плагин)

Статус: поддерживается через плагин (бот на вебхуках). Поддерживаются личные сообщения, комнаты, реакции и сообщения с markdown.

## Требуется плагин

Nextcloud Talk поставляется как плагин и не входит в основной установочный пакет.

Установка через CLI (реестр npm):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Локальная установка (при запуске из git-репозитория):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Если во время конфигурации/онбординга вы выбираете Nextcloud Talk и обнаруживается git-чекаут,
OpenClaw автоматически предложит путь для локальной установки.

Подробности: [Plugins](/tools/plugin)

## Быстрая настройка (для начинающих)

1. Установите плагин Nextcloud Talk.

2. На вашем сервере Nextcloud создайте бота:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Включите бота в настройках целевой комнаты.

4. Настройте OpenClaw:
   - Конфиг: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Или переменные окружения: `NEXTCLOUD_TALK_BOT_SECRET` (только для аккаунта по умолчанию)

5. Перезапустите Gateway (шлюз) (или завершите онбординг).

Минимальный конфиг:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Примечания

- Боты не могут инициировать личные сообщения. Пользователь должен написать боту первым.
- URL вебхука должен быть доступен для Gateway (шлюза); задайте `webhookPublicUrl`, если используется прокси.
- Загрузка медиа не поддерживается API бота; медиа отправляется в виде URL.
- Полезная нагрузка вебхука не различает личные сообщения и комнаты; задайте `apiUser` + `apiPassword` для включения определения типа комнаты (иначе личные сообщения трактуются как комнаты).

## Контроль доступа (личные сообщения)

- По умолчанию: `channels.nextcloud-talk.dmPolicy = "pairing"`. Неизвестные отправители получают код сопряжения.
- Подтверждение через:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Публичные личные сообщения: `channels.nextcloud-talk.dmPolicy="open"` плюс `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` сопоставляет только ID пользователей Nextcloud; отображаемые имена игнорируются.

## Комнаты (группы)

- По умолчанию: `channels.nextcloud-talk.groupPolicy = "allowlist"` (требуется упоминание).
- Разрешённые комнаты через `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Чтобы не разрешать ни одной комнаты, оставьте список разрешённых пустым или задайте `channels.nextcloud-talk.groupPolicy="disabled"`.

## Возможности

| Функция          | Статус            |
| ---------------- | ----------------- |
| Прямые сообщения | Поддерживается    |
| Комнаты          | Поддерживается    |
| Потоки           | Не поддерживается |
| Медиа            | Только URL        |
| Реакции          | Поддерживается    |
| Родные команды   | Не поддерживается |

## Справочник конфигурации (Nextcloud Talk)

Полная конфигурация: [Configuration](/gateway/configuration)

Параметры провайдера:

- `channels.nextcloud-talk.enabled`: включение/выключение запуска канала.
- `channels.nextcloud-talk.baseUrl`: URL экземпляра Nextcloud.
- `channels.nextcloud-talk.botSecret`: общий секрет бота.
- `channels.nextcloud-talk.botSecretFile`: путь к файлу с секретом.
- `channels.nextcloud-talk.apiUser`: API-пользователь для поиска комнат (определение личных сообщений).
- `channels.nextcloud-talk.apiPassword`: API/пароль приложения для поиска комнат.
- `channels.nextcloud-talk.apiPasswordFile`: путь к файлу с API-паролем.
- `channels.nextcloud-talk.webhookPort`: порт прослушивания вебхука (по умолчанию: 8788).
- `channels.nextcloud-talk.webhookHost`: хост вебхука (по умолчанию: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: путь вебхука (по умолчанию: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: внешний, доступный извне URL вебхука.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: список разрешённых для личных сообщений (ID пользователей). `open` требует `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: список разрешённых групп (ID пользователей).
- `channels.nextcloud-talk.rooms`: настройки и список разрешённых на уровне комнат.
- `channels.nextcloud-talk.historyLimit`: лимит истории для групп (0 отключает).
- `channels.nextcloud-talk.dmHistoryLimit`: лимит истории для личных сообщений (0 отключает).
- `channels.nextcloud-talk.dms`: переопределения для каждого личного сообщения (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: размер фрагмента исходящего текста (в символах).
- `channels.nextcloud-talk.chunkMode`: `length` (по умолчанию) или `newline` для разбиения по пустым строкам (границы абзацев) перед разбиением по длине.
- `channels.nextcloud-talk.blockStreaming`: отключить потоковую передачу блоками для этого канала.
- `channels.nextcloud-talk.blockStreamingCoalesce`: настройка объединения потоковой передачи блоками.
- `channels.nextcloud-talk.mediaMaxMb`: лимит входящих медиа (МБ).
