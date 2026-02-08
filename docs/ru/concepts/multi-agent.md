---
summary: "Маршрутизация с несколькими агентами: изолированные агенты, аккаунты каналов и привязки"
title: Маршрутизация с несколькими агентами
read_when: "Когда вам нужно несколько изолированных агентов (рабочие пространства + аутентификация) в одном процессе шлюза."
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:41Z
---

# Маршрутизация с несколькими агентами

Цель: несколько _изолированных_ агентов (отдельное рабочее пространство + `agentDir` + сеансы), а также несколько аккаунтов каналов (например, два WhatsApp) в одном запущенном Gateway (шлюзе). Входящие сообщения маршрутизируются к агенту через привязки.

## Что такое «один агент»?

**Агент** — это полностью изолированный «мозг» со своим:

- **Рабочим пространством** (файлы, AGENTS.md/SOUL.md/USER.md, локальные заметки, правила персоны).
- **Каталогом состояния** (`agentDir`) для профилей аутентификации, реестра моделей и конфига на агента.
- **Хранилищем сеансов** (история чатов + состояние маршрутизации) в `~/.openclaw/agents/<agentId>/sessions`.

Профили аутентификации — **для каждого агента**. Каждый агент читает из своего:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Основные учетные данные агента **не** разделяются автоматически. Никогда не используйте повторно `agentDir`
между агентами (это приводит к коллизиям аутентификации/сеансов). Если нужно разделить учетные данные,
скопируйте `auth-profiles.json` в `agentDir` другого агента.

Skills являются пер-агентными через папку `skills/` каждого рабочего пространства, при этом общие skills
доступны из `~/.openclaw/skills`. См. [Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills).

Gateway (шлюз) может размещать **один агент** (по умолчанию) или **несколько агентов** параллельно.

**Примечание о рабочем пространстве:** рабочее пространство каждого агента является **cwd по умолчанию**, а не жёстким
sandbox. Относительные пути разрешаются внутри рабочего пространства, но абсолютные пути могут
достигать других расположений хоста, если sandboxing не включён. См.
[Sandboxing](/gateway/sandboxing).

## Пути (быстрая карта)

- Конфигурация: `~/.openclaw/openclaw.json` (или `OPENCLAW_CONFIG_PATH`)
- Каталог состояния: `~/.openclaw` (или `OPENCLAW_STATE_DIR`)
- Рабочее пространство: `~/.openclaw/workspace` (или `~/.openclaw/workspace-<agentId>`)
- Каталог агента: `~/.openclaw/agents/<agentId>/agent` (или `agents.list[].agentDir`)
- Сеансы: `~/.openclaw/agents/<agentId>/sessions`

### Режим одного агента (по умолчанию)

Если ничего не настраивать, OpenClaw запускается с одним агентом:

- `agentId` по умолчанию равен **`main`**.
- Сеансы имеют ключи вида `agent:main:<mainKey>`.
- Рабочее пространство по умолчанию — `~/.openclaw/workspace` (или `~/.openclaw/workspace-<profile>`, когда установлен `OPENCLAW_PROFILE`).
- Каталог состояния по умолчанию — `~/.openclaw/agents/main/agent`.

## Помощник агента

Используйте мастер агента, чтобы добавить новый изолированный агент:

```bash
openclaw agents add work
```

Затем добавьте `bindings` (или позвольте мастеру сделать это), чтобы маршрутизировать входящие сообщения.

Проверьте с помощью:

```bash
openclaw agents list --bindings
```

## Несколько агентов = несколько людей, несколько персоналий

При **нескольких агентах** каждый `agentId` становится **полностью изолированной персоной**:

- **Разные номера телефонов/аккаунты** (для каждого канала `accountId`).
- **Разные личности** (файлы рабочего пространства на агента, такие как `AGENTS.md` и `SOUL.md`).
- **Раздельная аутентификация и сеансы** (без пересечений, если это явно не включено).

Это позволяет **нескольким людям** использовать один сервер Gateway, сохраняя их ИИ-«мозги» и данные изолированными.

## Один номер WhatsApp, несколько людей (разделение личных сообщений)

Вы можете маршрутизировать **разные личные сообщения WhatsApp** к разным агентам, оставаясь в рамках **одного аккаунта WhatsApp**. Сопоставление выполняется по E.164 отправителя (например, `+15551234567`) с помощью `peer.kind: "dm"`. Ответы по‑прежнему приходят с одного и того же номера WhatsApp (нет идентификации отправителя на агента).

Важная деталь: прямые чаты сворачиваются к **основному ключу сеанса** агента, поэтому для истинной изоляции требуется **один агент на человека**.

Пример:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Примечания:

- Контроль доступа к личным сообщениям — **глобальный для аккаунта WhatsApp** (сопряжение/список разрешённых), а не на агента.
- Для общих групп привяжите группу к одному агенту или используйте [Broadcast groups](/channels/broadcast-groups).

## Правила маршрутизации (как сообщения выбирают агента)

Привязки являются **детерминированными**, и **самое специфичное правило выигрывает**:

1. Совпадение `peer` (точный DM/группа/id канала)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. Совпадение `accountId` для канала
5. Совпадение на уровне канала (`accountId: "*"`)
6. Откат к агенту по умолчанию (`agents.list[].default`, иначе первый элемент списка, по умолчанию: `main`)

## Несколько аккаунтов / номеров телефонов

Каналы, поддерживающие **несколько аккаунтов** (например, WhatsApp), используют `accountId` для идентификации
каждого входа. Каждый `accountId` может быть направлен к разному агенту, поэтому один сервер может
обслуживать несколько номеров телефонов без смешения сеансов.

## Понятия

- `agentId`: один «мозг» (рабочее пространство, аутентификация на агента, хранилище сеансов на агента).
- `accountId`: один экземпляр аккаунта канала (например, аккаунт WhatsApp `"personal"` против `"biz"`).
- `binding`: маршрутизирует входящие сообщения к `agentId` по `(channel, accountId, peer)` и, при необходимости, идентификаторам гильдий/команд.
- Прямые чаты сворачиваются к `agent:<agentId>:<mainKey>` (пер-агентный «основной»; `session.mainKey`).

## Пример: два WhatsApp → два агента

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Пример: ежедневный чат в WhatsApp + глубокая работа в Telegram

Разделение по каналу: направляйте WhatsApp к быстрому повседневному агенту, а Telegram — к агенту Opus.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Примечания:

- Если у вас несколько аккаунтов для канала, добавьте `accountId` в привязку (например, `{ channel: "whatsapp", accountId: "personal" }`).
- Чтобы направить один DM/группу к Opus, оставив остальное на чат‑агенте, добавьте привязку `match.peer` для этого пира; совпадения по пиру всегда выигрывают у правил уровня канала.

## Пример: один канал, один пир — к Opus

Оставьте WhatsApp на быстром агенте, но направьте один DM к Opus:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Привязки по пиру всегда выигрывают, поэтому держите их выше правила уровня канала.

## Семейный агент, привязанный к группе WhatsApp

Привяжите выделенного семейного агента к одной группе WhatsApp с фильтрацией по упоминаниям
и более строгой политикой инструментов:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Примечания:

- Списки разрешений/запретов инструментов относятся к **tools**, а не к skills. Если skill должен запускать
  бинарник, убедитесь, что `exec` разрешён и бинарник существует в sandbox.
- Для более строгой фильтрации установите `agents.list[].groupChat.mentionPatterns` и оставьте
  включёнными списки разрешённых групп для канала.

## Sandbox и конфигурация инструментов на агента

Начиная с версии v2026.1.6, каждый агент может иметь собственный sandbox и ограничения инструментов:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

Примечание: `setupCommand` находится в `sandbox.docker` и выполняется один раз при создании контейнера.
Переопределения `sandbox.docker.*` на агента игнорируются, когда итоговая область равна `"shared"`.

**Преимущества:**

- **Изоляция безопасности**: ограничение инструментов для недоверенных агентов
- **Контроль ресурсов**: изоляция sandbox для отдельных агентов при сохранении работы других на хосте
- **Гибкие политики**: разные разрешения для разных агентов

Примечание: `tools.elevated` является **глобальным** и основанным на отправителе; его нельзя настраивать на агента.
Если нужны границы на агента, используйте `agents.list[].tools`, чтобы запретить `exec`.
Для таргетинга групп используйте `agents.list[].groupChat.mentionPatterns`, чтобы @упоминания корректно сопоставлялись с нужным агентом.

См. [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) для подробных примеров.
