---
summary: "iMessage через сервер BlueBubbles для macOS (REST-отправка/приём, набор текста, реакции, сопряжение, расширенные действия)."
read_when:
  - Настройка канала BlueBubbles
  - Устранение неполадок сопряжения вебхуков
  - Настройка iMessage на macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Статус: плагин в комплекте, который взаимодействует с сервером BlueBubbles для macOS по HTTP. **Рекомендуется для интеграции iMessage** благодаря более богатому API и более простой настройке по сравнению с устаревшим каналом imsg.

## Обзор

- Работает на macOS через вспомогательное приложение BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- Рекомендовано/протестировано: macOS Sequoia (15). macOS Tahoe (26) работает; редактирование в настоящее время сломано на Tahoe, а обновления иконок групп могут сообщать об успехе, но не синхронизироваться.
- OpenClaw взаимодействует с ним через REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Входящие сообщения поступают через вебхуки; исходящие ответы, индикаторы набора текста, уведомления о прочтении и tapback — через REST-вызовы.
- Вложения и стикеры принимаются как входящие медиа (и по возможности передаются агенту).
- Сопряжение/список разрешённых работает так же, как и в других каналах (`/channels/pairing` и т. д.) с `channels.bluebubbles.allowFrom` + кодами сопряжения.
- Реакции отображаются как системные события, как в Slack/Telegram, поэтому агенты могут «упоминать» их перед ответом.
- Расширенные возможности: редактирование, отмена отправки, ветвление ответов, эффекты сообщений, управление группами.

## Быстрый старт

1. Установите сервер BlueBubbles на Mac (следуйте инструкциям на [bluebubbles.app/install](https://bluebubbles.app/install)).

2. В конфигурации BlueBubbles включите web API и задайте пароль.

3. Запустите `openclaw onboard` и выберите BlueBubbles либо настройте вручную:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Укажите вебхуки BlueBubbles на ваш Gateway (шлюз) (пример: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Запустите Gateway (шлюз); он зарегистрирует обработчик вебхука и начнёт сопряжение.

## Поддержание активности Messages.app (VM / headless‑настройки)

Некоторые VM или постоянно работающие конфигурации macOS могут приводить к «засыпанию» Messages.app (входящие события прекращаются, пока приложение не открыто/не выведено на передний план). Простое обходное решение — **«пинать» Messages каждые 5 минут** с помощью AppleScript + LaunchAgent.

### 1. Сохраните AppleScript

Сохраните как:

- `~/Scripts/poke-messages.scpt`

Пример скрипта (неинтерактивный; не перехватывает фокус):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Установите LaunchAgent

Сохраните как:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Примечания:

- Выполняется **каждые 300 секунд** и **при входе в систему**.
- Первый запуск может вызвать запросы macOS **Automation** (`osascript` → Messages). Разрешите их в той же пользовательской сессии, где работает LaunchAgent.

Загрузите его:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Онбординг

BlueBubbles доступен в интерактивном мастере настройки:

```
openclaw onboard
```

Мастер запрашивает:

- **URL сервера** (обязательно): адрес сервера BlueBubbles (например, `http://192.168.1.100:1234`)
- **Пароль** (обязательно): пароль API из настроек BlueBubbles Server
- **Путь вебхука** (необязательно): по умолчанию `/bluebubbles-webhook`
- **Политика личных сообщений (DM)**: сопряжение, список разрешённых, открыто или отключено
- **Список разрешённых**: номера телефонов, адреса электронной почты или цели чатов

Также можно добавить BlueBubbles через CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Контроль доступа (личные сообщения + группы)

DMs:

- По умолчанию: `channels.bluebubbles.dmPolicy = "pairing"`.
- Неизвестные отправители получают код сопряжения; сообщения игнорируются до одобрения (коды истекают через 1 час).
- Одобрение через:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Сопряжение — обмен токенами по умолчанию. Подробности: [Pairing](/channels/pairing)

Группы:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (по умолчанию: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` управляет тем, кто может инициировать действия в группах, когда задано `allowlist`.

### Ограничение по упоминаниям (группы)

BlueBubbles поддерживает ограничение по упоминаниям для групповых чатов, соответствуя поведению iMessage/WhatsApp:

- Использует `agents.list[].groupChat.mentionPatterns` (или `messages.groupChat.mentionPatterns`) для обнаружения упоминаний.
- Когда для группы включено `requireMention`, агент отвечает только при упоминании.
- Управляющие команды от авторизованных отправителей обходят ограничение по упоминаниям.

Поконфигурация для группы:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Ограничение команд

- Управляющие команды (например, `/config`, `/model`) требуют авторизации.
- Используются `allowFrom` и `groupAllowFrom` для определения прав на команды.
- Авторизованные отправители могут выполнять управляющие команды даже без упоминания в группах.

## Набирать и читать квитанции

- **Индикаторы набора текста**: отправляются автоматически до и во время генерации ответа.
- **Уведомления о прочтении**: управляются параметром `channels.bluebubbles.sendReadReceipts` (по умолчанию: `true`).
- **Индикаторы набора текста**: OpenClaw отправляет события начала набора; BlueBubbles автоматически очищает набор при отправке или по тайм‑ауту (ручная остановка через DELETE ненадёжна).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Расширенные действия

BlueBubbles поддерживает расширенные действия с сообщениями при включении в конфиге:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Доступные действия:

- **react**: добавить/удалить реакции tapback (`messageId`, `emoji`, `remove`)
- **edit**: редактировать отправленное сообщение (`messageId`, `text`)
- **unsend**: отменить отправку сообщения (`messageId`)
- **reply**: ответить на конкретное сообщение (`messageId`, `text`, `to`)
- **sendWithEffect**: отправить с эффектом iMessage (`text`, `to`, `effectId`)
- **renameGroup**: переименовать групповой чат (`chatGuid`, `displayName`)
- **setGroupIcon**: задать иконку/фото группы (`chatGuid`, `media`) — нестабильно на macOS 26 Tahoe (API может вернуть успех, но иконка не синхронизируется).
- **addParticipant**: добавить участника в группу (`chatGuid`, `address`)
- **removeParticipant**: удалить участника из группы (`chatGuid`, `address`)
- **leaveGroup**: покинуть групповой чат (`chatGuid`)
- **sendAttachment**: отправить медиа/файлы (`to`, `buffer`, `filename`, `asVoice`)
  - Голосовые заметки: задайте `asVoice: true` с аудио **MP3** или **CAF**, чтобы отправить как голосовое сообщение iMessage. BlueBubbles конвертирует MP3 → CAF при отправке голосовых заметок.

### Идентификаторы сообщений (короткие vs полные)

OpenClaw может возвращать _короткие_ идентификаторы сообщений (например, `1`, `2`) для экономии токенов.

- `MessageSid` / `ReplyToId` могут быть короткими ID.
- `MessageSidFull` / `ReplyToIdFull` содержат полные ID провайдера.
- Короткие ID хранятся в памяти; они могут истечь при перезапуске или вытеснении кэша.
- Действия принимают короткие или полные `messageId`, но короткие ID вызовут ошибку, если они больше недоступны.

Для долговечных автоматизаций и хранения используйте полные ID:

- Шаблоны: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Контекст: `MessageSidFull` / `ReplyToIdFull` во входящих полезных нагрузках

См. [Configuration](/gateway/configuration) для переменных шаблонов.

## Потоковая передача блоками

Управляйте тем, отправляются ли ответы одним сообщением или потоково блоками:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Медиа + ограничения

- Входящие вложения загружаются и сохраняются в кэше медиа.
- Лимит медиа через `channels.bluebubbles.mediaMaxMb` (по умолчанию: 8 МБ).
- Исходящий текст нарезается до `channels.bluebubbles.textChunkLimit` (по умолчанию: 4000 символов).

## Справочник конфигурации

Полная конфигурация: [Configuration](/gateway/configuration)

Параметры провайдера:

- `channels.bluebubbles.enabled`: включить/отключить канал.
- `channels.bluebubbles.serverUrl`: базовый URL REST API BlueBubbles.
- `channels.bluebubbles.password`: пароль API.
- `channels.bluebubbles.webhookPath`: путь конечной точки вебхука (по умолчанию: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (по умолчанию: `pairing`).
- `channels.bluebubbles.allowFrom`: список разрешённых для DM (идентификаторы, email, номера E.164, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (по умолчанию: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: список разрешённых отправителей в группах.
- `channels.bluebubbles.groups`: поконфигурация для групп (`requireMention` и т. д.).
- `channels.bluebubbles.sendReadReceipts`: отправка уведомлений о прочтении (по умолчанию: `true`).
- `channels.bluebubbles.blockStreaming`: включить потоковую передачу блоками (по умолчанию: `false`; требуется для потоковых ответов).
- `channels.bluebubbles.textChunkLimit`: размер исходящих блоков в символах (по умолчанию: 4000).
- `channels.bluebubbles.chunkMode`: `length` (по умолчанию) разбивает только при превышении `textChunkLimit`; `newline` разбивает по пустым строкам (границы абзацев) перед нарезкой по длине.
- `channels.bluebubbles.mediaMaxMb`: лимит входящих медиа в МБ (по умолчанию: 8).
- `channels.bluebubbles.historyLimit`: максимум сообщений группы для контекста (0 — отключено).
- `channels.bluebubbles.dmHistoryLimit`: лимит истории DM.
- `channels.bluebubbles.actions`: включение/отключение отдельных действий.
- `channels.bluebubbles.accounts`: конфигурация нескольких аккаунтов.

Связанные глобальные параметры:

- `agents.list[].groupChat.mentionPatterns` (или `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Адресация / цели доставки

Для стабильной маршрутизации предпочитайте `chat_guid`:

- `chat_guid:iMessage;-;+15555550123` (предпочтительно для групп)
- `chat_id:123`
- `chat_identifier:...`
- Прямые идентификаторы: `+15555550123`, `user@example.com`
  - Если для прямого идентификатора нет существующего чата DM, OpenClaw создаст его через `POST /api/v1/chat/new`. Для этого требуется включённый Private API BlueBubbles.

## Безопасность

- Запросы вебхуков аутентифицируются путём сравнения параметров запроса или заголовков `guid`/`password` с `channels.bluebubbles.password`. Запросы от `localhost` также принимаются.
- Храните пароль API и конечную точку вебхука в секрете (обращайтесь с ними как с учётными данными).
- Доверие к localhost означает, что обратный прокси на том же хосте может непреднамеренно обойти пароль. Если вы проксируете Gateway (шлюз), требуйте аутентификацию на прокси и настройте `gateway.trustedProxies`. См. [Gateway security](/gateway/security#reverse-proxy-configuration).
- Включите HTTPS и правила брандмауэра на сервере BlueBubbles, если вы открываете его вне вашей LAN.

## Устранение неполадок

- Если индикаторы набора/прочтения перестали работать, проверьте логи вебхуков BlueBubbles и убедитесь, что путь Gateway (шлюза) совпадает с `channels.bluebubbles.webhookPath`.
- Коды сопряжения истекают через один час; используйте `openclaw pairing list bluebubbles` и `openclaw pairing approve bluebubbles <code>`.
- Реакции требуют Private API BlueBubbles (`POST /api/v1/message/react`); убедитесь, что версия сервера его предоставляет.
- Редактирование/отмена отправки требуют macOS 13+ и совместимую версию сервера BlueBubbles. На macOS 26 (Tahoe) редактирование в настоящее время сломано из‑за изменений Private API.
- Обновления иконок групп могут быть нестабильны на macOS 26 (Tahoe): API может вернуть успех, но новая иконка не синхронизируется.
- OpenClaw автоматически скрывает известные неработающие действия на основе версии macOS сервера BlueBubbles. Если редактирование всё ещё отображается на macOS 26 (Tahoe), отключите его вручную с помощью `channels.bluebubbles.actions.edit=false`.
- Для информации о статусе/здоровье: `openclaw status --all` или `openclaw status --deep`.

Для общего обзора рабочего процесса каналов см. [Channels](/channels) и руководство [Plugins](/tools/plugin).
