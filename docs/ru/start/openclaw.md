---
summary: "Сквозное руководство по запуску OpenClaw в роли персонального ассистента с предупреждениями по безопасности"
read_when:
  - Онбординг нового экземпляра ассистента
  - Обзор последствий для безопасности и прав доступа
title: "Настройка персонального ассистента"
---

# Создание персонального ассистента с OpenClaw

OpenClaw — это шлюз WhatsApp + Telegram + Discord + iMessage для агентов **Pi**. Плагины добавляют Mattermost. Это руководство описывает настройку «персонального ассистента»: один выделенный номер WhatsApp, который ведёт себя как ваш постоянно включённый агент.

## ⚠️ Безопасность прежде всего

Вы помещаете агента в положение, при котором он может:

- выполнять команды на вашем компьютере (в зависимости от настройки инструментов Pi)
- читать и записывать файлы в вашем рабочем пространстве
- отправлять сообщения наружу через WhatsApp/Telegram/Discord/Mattermost (плагин)

Начинайте консервативно:

- Всегда устанавливайте `channels.whatsapp.allowFrom` (никогда не запускайте «открыто в интернет» на вашем личном Mac).
- Используйте выделенный номер WhatsApp для ассистента.
- Сигналы keepalive теперь по умолчанию отправляются каждые 30 минут. Отключите их, пока не начнёте доверять настройке, установив `agents.defaults.heartbeat.every: "0m"`.

## Предварительные требования

- OpenClaw установлен и прошёл онбординг — см. [Начало работы](/start/getting-started), если вы ещё этого не сделали
- Второй номер телефона (SIM/eSIM/предоплаченный) для ассистента

## Схема с двумя телефонами (рекомендуется)

Вам нужно следующее:

```
Your Phone (personal)          Second Phone (assistant)
┌─────────────────┐           ┌─────────────────┐
│  Your WhatsApp  │  ──────▶  │  Assistant WA   │
│  +1-555-YOU     │  message  │  +1-555-ASSIST  │
└─────────────────┘           └────────┬────────┘
                                       │ linked via QR
                                       ▼
                              ┌─────────────────┐
                              │  Your Mac       │
                              │  (openclaw)      │
                              │    Pi agent     │
                              └─────────────────┘
```

Если вы подключите ваш личный WhatsApp к OpenClaw, каждое сообщение вам станет «входом агента». Обычно это совсем не то, что нужно.

## Быстрый старт за 5 минут

1. Подключите WhatsApp Web (появится QR-код; отсканируйте его телефоном ассистента):

```bash
openclaw channels login
```

2. Запустите Gateway (шлюз) (оставьте его работать):

```bash
openclaw gateway --port 18789
```

3. Поместите минимальный конфиг в `~/.openclaw/openclaw.json`:

```json5
{
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Теперь отправьте сообщение на номер ассистента со своего телефона из списка разрешённых.

Когда онбординг завершится, мы автоматически откроем дашборд и выведем «чистую» (без токенов) ссылку. Если потребуется аутентификация, вставьте токен из `gateway.auth.token` в настройки Control UI. Чтобы открыть позже: `openclaw dashboard`.

## Дайте агенту рабочее пространство (AGENTS)

OpenClaw читает операционные инструкции и «память» из каталога рабочего пространства.

По умолчанию OpenClaw использует `~/.openclaw/workspace` в качестве рабочего пространства агента и автоматически создаёт его (а также стартовые `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`) при настройке/первом запуске агента. `BOOTSTRAP.md` создаётся только когда рабочее пространство совершенно новое (оно не должно появляться снова после удаления). `MEMORY.md` является необязательным (не создаётся автоматически); при наличии оно загружается для обычных сеансов. Сеансы субагентов внедряют только `AGENTS.md` и `TOOLS.md`.

Совет: относитесь к этой папке как к «памяти» OpenClaw и сделайте её git-репозиторием (желательно приватным), чтобы ваши `AGENTS.md` и файлы памяти были резервно сохранены. Если git установлен, совершенно новые рабочие пространства автоматически инициализируются.

```bash
openclaw setup
```

Полная структура рабочего пространства + руководство по резервному копированию: [Рабочее пространство агента](/concepts/agent-workspace)  
Рабочий процесс памяти: [Память](/concepts/memory)

Опционально: выберите другое рабочее пространство с помощью `agents.defaults.workspace` (поддерживает `~`).

```json5
{
  agent: {
    workspace: "~/.openclaw/workspace",
  },
}
```

Если вы уже поставляете собственные файлы рабочего пространства из репозитория, можно полностью отключить создание bootstrap-файлов:

```json5
{
  agent: {
    skipBootstrap: true,
  },
}
```

## Конфиг, который превращает его в «ассистента»

По умолчанию OpenClaw настроен как хороший ассистент, но обычно требуется донастройка:

- персона/инструкции в `SOUL.md`
- параметры рассуждений (при необходимости)
- сердцебиты (только вы доверяете)

Пример:

```json5
{
  logging: { level: "info" },
  agent: {
    model: "anthropic/claude-opus-4-6",
    workspace: "~/.openclaw/workspace",
    thinkingDefault: "high",
    timeoutSeconds: 1800,
    // Start with 0; enable later.
    heartbeat: { every: "0m" },
  },
  channels: {
    whatsapp: {
      allowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  routing: {
    groupChat: {
      mentionPatterns: ["@openclaw", "openclaw"],
    },
  },
  session: {
    scope: "per-sender",
    resetTriggers: ["/new", "/reset"],
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 10080,
    },
  },
}
```

## Сеансы и память

- Файлы сеансов: `~/.openclaw/agents/<agentId>/sessions/{{SessionId}}.jsonl`
- Метаданные сеансов (использование токенов, последний маршрут и т. п.): `~/.openclaw/agents/<agentId>/sessions/sessions.json` (legacy: `~/.openclaw/sessions/sessions.json`)
- `/new` или `/reset` начинает новый сеанс для этого чата (настраивается через `resetTriggers`). Если отправлено отдельно, агент отвечает коротким приветствием для подтверждения сброса.
- `/compact [instructions]` уплотняет контекст сеанса и сообщает оставшийся бюджет контекста.

## Сердцебиты (проактивный)

По умолчанию OpenClaw запускает сигнал keepalive каждые 30 минут с подсказкой:
`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`  
Установите `agents.defaults.heartbeat.every: "0m"`, чтобы отключить.

- Если `HEARTBEAT.md` существует, но фактически пуст (только пустые строки и заголовки Markdown вроде `# Heading`), OpenClaw пропускает запуск сигнала keepalive, чтобы сэкономить API-вызовы.
- Если файл отсутствует, сигнал keepalive всё равно выполняется, и модель сама решает, что делать.
- Если агент отвечает `HEARTBEAT_OK` (опционально с коротким заполнением; см. `agents.defaults.heartbeat.ackMaxChars`), OpenClaw подавляет исходящую доставку для этого сигнала keepalive.
- Сигналы keepalive выполняют полные ходы агента — более короткие интервалы сжигают больше токенов.

```json5
{
  agent: {
    heartbeat: { every: "30m" },
  },
}
```

## Медиа на входе и выходе

Входящие вложения (изображения/аудио/документы) могут быть переданы вашей команде через шаблоны:

- `{{MediaPath}}` (путь к локальному временному файлу)
- `{{MediaUrl}}` (псевдо-URL)
- `{{Transcript}}` (если включена транскрипция аудио)

Исходящие вложения от агента: включите `MEDIA:<path-or-url>` отдельной строкой (без пробелов). Пример:

```
Here’s the screenshot.
MEDIA:https://example.com/screenshot.png
```

OpenClaw извлекает их и отправляет как медиа вместе с текстом.

## Операционный чек-лист

```bash
openclaw status          # local status (creds, sessions, queued events)
openclaw status --all    # full diagnosis (read-only, pasteable)
openclaw status --deep   # adds gateway health probes (Telegram + Discord)
openclaw health --json   # gateway health snapshot (WS)
```

Логи находятся в `/tmp/openclaw/` (по умолчанию: `openclaw-YYYY-MM-DD.log`).

## Дальнейшие шаги

- WebChat: [WebChat](/web/webchat)
- Эксплуатация Gateway (шлюза): [Gateway runbook](/gateway)
- Cron + пробуждения: [Cron jobs](/automation/cron-jobs)
- Компаньон в строке меню macOS: [OpenClaw macOS app](/platforms/macos)
- Приложение узла для iOS: [iOS app](/platforms/ios)
- Приложение узла для Android: [Android app](/platforms/android)
- Статус Windows: [Windows (WSL2)](/platforms/windows)
- Статус Linux: [Linux app](/platforms/linux)
- Безопасность: [Security](/gateway/security)
