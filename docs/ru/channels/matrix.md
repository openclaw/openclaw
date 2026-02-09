---
summary: "Статус поддержки Matrix, возможности и конфигурация"
read_when:
  - Работа над функциями канала Matrix
title: "Matrix"
---

# Matrix (плагин)

Matrix — это открытый децентрализованный протокол обмена сообщениями. OpenClaw подключается как **пользователь** Matrix
на любом домашнем сервере (homeserver), поэтому для бота требуется учётная запись Matrix. После входа в систему
вы можете писать боту в личные сообщения или приглашать его в комнаты (Matrix «группы»). Beeper также является допустимым клиентом,
но требует включения E2EE.

Статус: поддерживается через плагин (@vector-im/matrix-bot-sdk). Личные сообщения, комнаты, треды, медиа, реакции,
опросы (отправка + poll-start как текст), геолокация и E2EE (с криптоподдержкой).

## Требуется плагин

Matrix поставляется как плагин и не входит в базовую установку.

Установка через CLI (реестр npm):

```bash
openclaw plugins install @openclaw/matrix
```

Локальный checkout (при запуске из git-репозитория):

```bash
openclaw plugins install ./extensions/matrix
```

Если вы выбираете Matrix во время конфигурации/онбординга и обнаружен git-checkout,
OpenClaw автоматически предложит путь локальной установки.

Подробности: [Plugins](/tools/plugin)

## Настройка

1. Установите плагин Matrix:
   - Из npm: `openclaw plugins install @openclaw/matrix`
   - Из локального checkout: `openclaw plugins install ./extensions/matrix`

2. Создайте учётную запись Matrix на homeserver:
   - Посмотрите варианты хостинга на [https://matrix.org/ecosystem/hosting/](https://matrix.org/ecosystem/hosting/)
   - Или разверните свой собственный.

3. Получите access token для учётной записи бота:

   - Используйте API входа Matrix с `curl` на вашем домашнем сервере:

   ```bash
   curl --request POST \
     --url https://matrix.example.org/_matrix/client/v3/login \
     --header 'Content-Type: application/json' \
     --data '{
     "type": "m.login.password",
     "identifier": {
       "type": "m.id.user",
       "user": "your-user-name"
     },
     "password": "your-password"
   }'
   ```

   - Замените `matrix.example.org` на URL вашего homeserver.
   - Либо задайте `channels.matrix.userId` + `channels.matrix.password`: OpenClaw вызывает тот же
     эндпоинт входа, сохраняет access token в `~/.openclaw/credentials/matrix/credentials.json`,
     и повторно использует его при следующем запуске.

4. Настройте учётные данные:
   - Env: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` (или `MATRIX_USER_ID` + `MATRIX_PASSWORD`)
   - Или в конфиге: `channels.matrix.*`
   - Если заданы оба варианта, приоритет у конфига.
   - При использовании access token идентификатор пользователя извлекается автоматически через `/whoami`.
   - Если задано, `channels.matrix.userId` должен быть полным Matrix ID (пример: `@bot:example.org`).

5. Перезапустите Gateway (шлюз) (или завершите онбординг).

6. Начните личный диалог с ботом или пригласите его в комнату из любого клиента Matrix
   (Element, Beeper и т. п.; см. [https://matrix.org/ecosystem/clients/](https://matrix.org/ecosystem/clients/)). Beeper требует E2EE,
   поэтому установите `channels.matrix.encryption: true` и подтвердите устройство.

Минимальный конфиг (access token, user ID извлекается автоматически):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      dm: { policy: "pairing" },
    },
  },
}
```

Конфиг E2EE (включено сквозное шифрование):

```json5
{
  channels: {
    matrix: {
      enabled: true,
      homeserver: "https://matrix.example.org",
      accessToken: "syt_***",
      encryption: true,
      dm: { policy: "pairing" },
    },
  },
}
```

## Шифрование (E2EE)

Сквозное шифрование **поддерживается** через Rust crypto SDK.

Включается с помощью `channels.matrix.encryption: true`:

- Если криптомодуль загружается, зашифрованные комнаты автоматически расшифровываются.
- Исходящие медиа шифруются при отправке в зашифрованные комнаты.
- При первом подключении OpenClaw запрашивает подтверждение устройства у ваших других сессий.
- Подтвердите устройство в другом клиенте Matrix (Element и т. п.) для включения обмена ключами.
- Если криптомодуль не удаётся загрузить, E2EE отключается, а зашифрованные комнаты не будут расшифровываться;
  OpenClaw записывает предупреждение в лог.
- Если вы видите ошибки отсутствия криптомодуля (например, `@matrix-org/matrix-sdk-crypto-nodejs-*`),
  разрешите скрипты сборки для `@matrix-org/matrix-sdk-crypto-nodejs` и выполните
  `pnpm rebuild @matrix-org/matrix-sdk-crypto-nodejs` либо загрузите бинарник с помощью
  `node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.

Состояние криптографии хранится для каждой учётной записи + access token в
`~/.openclaw/matrix/accounts/<account>/<homeserver>__<user>/<token-hash>/crypto/`
(база данных SQLite). Состояние синхронизации находится рядом в `bot-storage.json`.
Если access token (устройство) меняется, создаётся новое хранилище, и бота необходимо
повторно подтвердить для зашифрованных комнат.

**Подтверждение устройства:**
Когда E2EE включено, бот при запуске запрашивает подтверждение у ваших других сессий.
Откройте Element (или другой клиент) и одобрите запрос подтверждения, чтобы установить доверие.
После подтверждения бот сможет расшифровывать сообщения в зашифрованных комнатах.

## Модель маршрутизации

- Ответы всегда возвращаются в Matrix.
- Личные сообщения используют основной сеанс агента; комнаты сопоставляются с групповыми сеансами.

## Контроль доступа (личные сообщения)

- По умолчанию: `channels.matrix.dm.policy = "pairing"`. Неизвестные отправители получают код сопряжения.
- Подтверждение через:
  - `openclaw pairing list matrix`
  - `openclaw pairing approve matrix <CODE>`
- Публичные личные сообщения: `channels.matrix.dm.policy="open"` плюс `channels.matrix.dm.allowFrom=["*"]`.
- `channels.matrix.dm.allowFrom` принимает полные Matrix user ID (пример: `@user:server`). Мастер настройки разрешает отображаемые имена в user ID, когда поиск в каталоге находит единственное точное совпадение.

## Комнаты (группы)

- По умолчанию: `channels.matrix.groupPolicy = "allowlist"` (ограничение по упоминанию). Используйте `channels.defaults.groupPolicy`, чтобы переопределить значение по умолчанию, если оно не задано.
- Разрешите комнаты через список разрешённых с помощью `channels.matrix.groups` (ID комнат или алиасы; имена разрешаются в ID, когда поиск в каталоге находит единственное точное совпадение):

```json5
{
  channels: {
    matrix: {
      groupPolicy: "allowlist",
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
      groupAllowFrom: ["@owner:example.org"],
    },
  },
}
```

- `requireMention: false` включает автоответ в этой комнате.
- `groups."*"` позволяет задать значения по умолчанию для ограничений по упоминаниям в комнатах.
- `groupAllowFrom` ограничивает, какие отправители могут триггерить бота в комнатах (полные Matrix user ID).
- Списки разрешённых `users` на уровне комнаты могут дополнительно ограничивать отправителей внутри конкретной комнаты (используйте полные Matrix user ID).
- Мастер настройки запрашивает allowlist комнат (ID, алиасы или имена) и разрешает имена только при точном уникальном совпадении.
- При запуске OpenClaw разрешает имена комнат/пользователей в списках разрешённых в ID и логирует соответствие; неразрешённые записи игнорируются при сопоставлении allowlist.
- Приглашения по умолчанию принимаются автоматически; управление через `channels.matrix.autoJoin` и `channels.matrix.autoJoinAllowlist`.
- Чтобы **запретить все комнаты**, установите `channels.matrix.groupPolicy: "disabled"` (или оставьте allowlist пустым).
- Устаревший ключ: `channels.matrix.rooms` (та же форма, что и `groups`).

## Потоки

- Поддерживаются ответы в тредах.
- `channels.matrix.threadReplies` управляет тем, остаются ли ответы в тредах:
  - `off`, `inbound` (по умолчанию), `always`
- `channels.matrix.replyToMode` управляет метаданными «reply-to», когда ответ не в треде:
  - `off` (по умолчанию), `first`, `all`

## Возможности

| Функция          | Статус                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Прямые сообщения | ✅ Поддерживается                                                                                                             |
| Комнаты          | ✅ Поддерживается                                                                                                             |
| Потоки           | ✅ Поддерживается                                                                                                             |
| Медиа            | ✅ Поддерживается                                                                                                             |
| E2EE             | ✅ Поддерживается (требуется криптомодуль)                                                                 |
| Реакции          | ✅ Поддерживается (отправка/чтение через инструменты)                                                      |
| Опросы           | ✅ Поддерживается отправка; входящие старты опросов преобразуются в текст (ответы/завершения игнорируются) |
| Геолокация       | ✅ Поддерживается (geo URI; высота игнорируется)                                                           |
| Родные команды   | ✅ Поддерживается                                                                                                             |

## Устранение неполадок

Сначала запустите лестницу:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Затем при необходимости проверьте состояние сопряжения личных сообщений:

```bash
openclaw pairing list matrix
```

Частые сбои:

- Вход выполнен, но сообщения в комнатах игнорируются: комната заблокирована `groupPolicy` или списком разрешённых комнат.
- Личные сообщения игнорируются: отправитель ожидает подтверждения при `channels.matrix.dm.policy="pairing"`.
- Сбой в зашифрованных комнатах: отсутствует криптоподдержка или несоответствие настроек шифрования.

Схема диагностики: [/channels/troubleshooting](/channels/troubleshooting).

## Справочник конфигурации (Matrix)

Полная конфигурация: [Configuration](/gateway/configuration)

Параметры провайдера:

- `channels.matrix.enabled`: включение/отключение запуска канала.
- `channels.matrix.homeserver`: URL homeserver.
- `channels.matrix.userId`: Matrix user ID (необязательно при наличии access token).
- `channels.matrix.accessToken`: access token.
- `channels.matrix.password`: пароль для входа (токен сохраняется).
- `channels.matrix.deviceName`: отображаемое имя устройства.
- `channels.matrix.encryption`: включение E2EE (по умолчанию: false).
- `channels.matrix.initialSyncLimit`: лимит начальной синхронизации.
- `channels.matrix.threadReplies`: `off | inbound | always` (по умолчанию: inbound).
- `channels.matrix.textChunkLimit`: размер чанка исходящего текста (символы).
- `channels.matrix.chunkMode`: `length` (по умолчанию) или `newline` для разбиения по пустым строкам (границы абзацев) перед разбиением по длине.
- `channels.matrix.dm.policy`: `pairing | allowlist | open | disabled` (по умолчанию: pairing).
- `channels.matrix.dm.allowFrom`: allowlist личных сообщений (полные Matrix user ID). `open` требует `"*"`. Мастер настройки разрешает имена в ID, когда это возможно.
- `channels.matrix.groupPolicy`: `allowlist | open | disabled` (по умолчанию: allowlist).
- `channels.matrix.groupAllowFrom`: разрешённые отправители для групповых сообщений (полные Matrix user ID).
- `channels.matrix.allowlistOnly`: принудительное применение правил allowlist для личных сообщений и комнат.
- `channels.matrix.groups`: allowlist групп + карта настроек по комнатам.
- `channels.matrix.rooms`: устаревший allowlist/конфиг групп.
- `channels.matrix.replyToMode`: режим «reply-to» для тредов/тегов.
- `channels.matrix.mediaMaxMb`: лимит медиа на вход/выход (МБ).
- `channels.matrix.autoJoin`: обработка приглашений (`always | allowlist | off`, по умолчанию: always).
- `channels.matrix.autoJoinAllowlist`: разрешённые ID/алиасы комнат для авто-вступления.
- `channels.matrix.actions`: ограничение инструментов по действиям (reactions/messages/pins/memberInfo/channelInfo).
