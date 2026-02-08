---
summary: "Поддержка устаревшего iMessage через imsg (JSON-RPC через stdio). Для новых установок следует использовать BlueBubbles."
read_when:
  - Настройка поддержки iMessage
  - Отладка отправки/приёма iMessage
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:30Z
---

# iMessage (legacy: imsg)

> **Рекомендуется:** Для новых настроек iMessage используйте [BlueBubbles](/channels/bluebubbles).
>
> Канал `imsg` является устаревшей интеграцией через внешний CLI и может быть удалён в будущих релизах.

Статус: устаревшая интеграция через внешний CLI. Gateway (шлюз) запускает `imsg rpc` (JSON-RPC через stdio).

## Быстрая настройка (для начинающих)

1. Убедитесь, что Messages выполнен вход на этом Mac.
2. Установите `imsg`:
   - `brew install steipete/tap/imsg`
3. Настройте OpenClaw с помощью `channels.imessage.cliPath` и `channels.imessage.dbPath`.
4. Запустите шлюз и подтвердите все запросы macOS (Automation + Full Disk Access).

Минимальный конфиг:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## Что это такое

- Канал iMessage, работающий на основе `imsg` в macOS.
- Детерминированная маршрутизация: ответы всегда возвращаются в iMessage.
- Личные сообщения используют основной сеанс агента; группы изолированы (`agent:<agentId>:imessage:group:<chat_id>`).
- Если поток с несколькими участниками приходит с `is_group=false`, вы всё равно можете изолировать его, настроив `chat_id` с помощью `channels.imessage.groups` (см. «Псевдогрупповые потоки» ниже).

## Запись конфига

По умолчанию iMessage разрешено записывать обновления конфига, инициированные `/config set|unset` (требуется `commands.config: true`).

Отключение:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Требования

- macOS с выполненным входом в Messages.
- Full Disk Access для OpenClaw + `imsg` (доступ к БД Messages).
- Разрешение Automation при отправке.
- `channels.imessage.cliPath` может указывать на любую команду, проксирующую stdin/stdout (например, скрипт-обёртку, который подключается по SSH к другому Mac и запускает `imsg rpc`).

## Устранение неполадок macOS Privacy and Security TCC

Если отправка/приём не работают (например, `imsg rpc` завершается с ненулевым кодом, истекает по тайм-ауту или шлюз выглядит «зависшим»), частой причиной является неподтверждённый запрос разрешений macOS.

macOS выдаёт разрешения TCC для каждого контекста приложения/процесса. Подтвердите запросы в том же контексте, где запускается `imsg` (например, Terminal/iTerm, сессия LaunchAgent или процесс, запущенный по SSH).

Чек-лист:

- **Full Disk Access**: разрешите доступ процессу, запускающему OpenClaw (и любой shell/SSH-обёртке, которая выполняет `imsg`). Это требуется для чтения базы данных Messages (`chat.db`).
- **Automation → Messages**: разрешите процессу, запускающему OpenClaw (и/или вашему терминалу), управлять **Messages.app** для исходящей отправки.
- **Состояние CLI `imsg`**: убедитесь, что `imsg` установлен и поддерживает RPC (`imsg rpc --help`).

Совет: если OpenClaw работает без GUI (LaunchAgent/systemd/SSH), запрос macOS легко пропустить. Выполните одноразовую интерактивную команду в GUI-терминале, чтобы принудительно показать запрос, затем повторите попытку:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Связанные разрешения папок macOS (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).

## Настройка (быстрый путь)

1. Убедитесь, что Messages выполнен вход на этом Mac.
2. Настройте iMessage и запустите шлюз.

### Выделенный пользователь macOS для бота (для изолированной идентичности)

Если вы хотите, чтобы бот отправлял сообщения от **отдельной учётной записи iMessage** (и не засорял ваши личные Messages), используйте отдельный Apple ID и отдельного пользователя macOS.

1. Создайте отдельный Apple ID (пример: `my-cool-bot@icloud.com`).
   - Apple может потребовать номер телефона для верификации / 2FA.
2. Создайте пользователя macOS (пример: `openclawhome`) и войдите под ним.
3. Откройте Messages под этим пользователем macOS и войдите в iMessage, используя Apple ID бота.
4. Включите Remote Login (System Settings → General → Sharing → Remote Login).
5. Установите `imsg`:
   - `brew install steipete/tap/imsg`
6. Настройте SSH так, чтобы `ssh <bot-macos-user>@localhost true` работал без пароля.
7. Укажите `channels.imessage.accounts.bot.cliPath` на SSH-обёртку, которая запускает `imsg` от имени пользователя бота.

Примечание о первом запуске: отправка/приём могут потребовать GUI-разрешений (Automation + Full Disk Access) у _пользователя macOS бота_. Если `imsg rpc` выглядит зависшим или завершается, войдите под этим пользователем (помогает Screen Sharing), выполните одноразово `imsg chats --limit 1` / `imsg send ...`, подтвердите запросы и повторите попытку. См. [Устранение неполадок macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc).

Пример обёртки (`chmod +x`). Замените `<bot-macos-user>` на фактическое имя пользователя macOS:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Пример конфига:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Для одноаккаунтных установок используйте плоские параметры (`channels.imessage.cliPath`, `channels.imessage.dbPath`) вместо карты `accounts`.

### Удалённый/SSH-вариант (необязательно)

Если iMessage нужен на другом Mac, установите `channels.imessage.cliPath` на обёртку, которая запускает `imsg` на удалённом хосте macOS по SSH. OpenClaw требуется только stdio.

Пример обёртки:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Удалённые вложения:** когда `cliPath` указывает на удалённый хост через SSH, пути вложений в базе данных Messages ссылаются на файлы на удалённой машине. OpenClaw может автоматически получать их по SCP, установив `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

Если `remoteHost` не задан, OpenClaw пытается определить его автоматически, разбирая SSH-команду в вашем скрипте-обёртке. Для надёжности рекомендуется явная конфигурация.

#### Удалённый Mac через Tailscale (пример)

Если Gateway (шлюз) работает на Linux-хосте/ВМ, а iMessage должен работать на Mac, Tailscale — самый простой мост: шлюз общается с Mac по tailnet, запускает `imsg` по SSH и копирует вложения обратно по SCP.

Архитектура:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Конкретный пример конфига (hostname Tailscale):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Пример обёртки (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Примечания:

- Убедитесь, что Mac выполнен вход в Messages и включён Remote Login.
- Используйте SSH-ключи, чтобы `ssh bot@mac-mini.tailnet-1234.ts.net` работал без запросов.
- `remoteHost` должен совпадать с SSH-целью, чтобы SCP мог получать вложения.

Поддержка нескольких аккаунтов: используйте `channels.imessage.accounts` с конфигурацией для каждого аккаунта и необязательным `name`. См. [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) для общего шаблона. Не коммитьте `~/.openclaw/openclaw.json` (часто содержит токены).

## Контроль доступа (личные сообщения + группы)

Личные сообщения:

- По умолчанию: `channels.imessage.dmPolicy = "pairing"`.
- Неизвестные отправители получают код сопряжения; сообщения игнорируются до подтверждения (коды истекают через 1 час).
- Подтверждение через:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Сопряжение — стандартный обмен токенами для личных сообщений iMessage. Подробности: [Pairing](/channels/pairing)

Группы:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` управляет тем, кто может триггерить в группах, когда установлен `allowlist`.
- Ограничение по упоминаниям использует `agents.list[].groupChat.mentionPatterns` (или `messages.groupChat.mentionPatterns`), поскольку iMessage не имеет нативных метаданных упоминаний.
- Переопределение для нескольких агентов: задайте шаблоны для каждого агента в `agents.list[].groupChat.mentionPatterns`.

## Как это работает (поведение)

- `imsg` потоково передаёт события сообщений; шлюз нормализует их в общий конверт канала.
- Ответы всегда маршрутизируются обратно в тот же идентификатор чата или handle.

## Псевдогрупповые потоки (`is_group=false`)

Некоторые потоки iMessage могут иметь несколько участников, но при этом приходить с `is_group=false` в зависимости от того, как Messages хранит идентификатор чата.

Если вы явно настроите `chat_id` в разделе `channels.imessage.groups`, OpenClaw будет обрабатывать этот поток как «группу» для:

- изоляции сеансов (отдельный ключ сеанса `agent:<agentId>:imessage:group:<chat_id>`)
- поведения allowlist для групп / ограничения по упоминаниям

Пример:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

Это полезно, если вам нужна изолированная личность/модель для конкретного потока (см. [Маршрутизация нескольких агентов](/concepts/multi-agent)). Для изоляции файловой системы см. [Sandboxing](/gateway/sandboxing).

## Медиа + ограничения

- Необязательная загрузка вложений в контекст через `channels.imessage.includeAttachments`.
- Лимит медиа через `channels.imessage.mediaMaxMb`.

## Ограничения

- Исходящий текст разбивается на чанки по `channels.imessage.textChunkLimit` (по умолчанию 4000).
- Необязательная разбивка по новым строкам: установите `channels.imessage.chunkMode="newline"`, чтобы делить по пустым строкам (границы абзацев) перед разбивкой по длине.
- Загрузка медиа ограничена параметром `channels.imessage.mediaMaxMb` (по умолчанию 16).

## Адресация / цели доставки

Для стабильной маршрутизации предпочтительно использовать `chat_id`:

- `chat_id:123` (предпочтительно)
- `chat_guid:...`
- `chat_identifier:...`
- прямые handle: `imessage:+1555` / `sms:+1555` / `user@example.com`

Список чатов:

```
imsg chats --limit 20
```

## Справочник конфигурации (iMessage)

Полная конфигурация: [Конфигурация](/gateway/configuration)

Параметры провайдера:

- `channels.imessage.enabled`: включить/отключить запуск канала.
- `channels.imessage.cliPath`: путь к `imsg`.
- `channels.imessage.dbPath`: путь к базе данных Messages.
- `channels.imessage.remoteHost`: SSH-хост для передачи вложений по SCP, когда `cliPath` указывает на удалённый Mac (например, `user@gateway-host`). Автоопределяется из SSH-обёртки, если не задан.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: регион SMS.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (по умолчанию: сопряжение).
- `channels.imessage.allowFrom`: allowlist для личных сообщений (handle, email, номера E.164 или `chat_id:*`). `open` требует `"*"`. В iMessage нет имён пользователей; используйте handle или цели чатов.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (по умолчанию: allowlist).
- `channels.imessage.groupAllowFrom`: allowlist отправителей для групп.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: максимальное число сообщений группы, включаемых в контекст (0 отключает).
- `channels.imessage.dmHistoryLimit`: лимит истории личных сообщений в пользовательских ходах. Переопределения для пользователей: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: значения по умолчанию для каждой группы + allowlist (используйте `"*"` для глобальных значений по умолчанию).
- `channels.imessage.includeAttachments`: загружать вложения в контекст.
- `channels.imessage.mediaMaxMb`: лимит медиа для входящих/исходящих (МБ).
- `channels.imessage.textChunkLimit`: размер исходящих чанков (символы).
- `channels.imessage.chunkMode`: `length` (по умолчанию) или `newline` для разбивки по пустым строкам (границы абзацев) перед разбивкой по длине.

Связанные глобальные параметры:

- `agents.list[].groupChat.mentionPatterns` (или `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
