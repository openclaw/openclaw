---
summary: "Песочница и ограничения инструментов для каждого агента, приоритеты и примеры"
title: Песочница и инструменты для нескольких агентов
read_when: "Когда требуется песочница для каждого агента или политики разрешения/запрета инструментов для каждого агента в многоагентном шлюзе."
status: active
---

# Конфигурация песочницы и инструментов для нескольких агентов

## Обзор

Каждый агент в многоагентной конфигурации теперь может иметь собственные:

- **Настройки песочницы** (`agents.list[].sandbox` переопределяет `agents.defaults.sandbox`)
- **Ограничения инструментов** (`tools.allow` / `tools.deny`, плюс `agents.list[].tools`)

Это позволяет запускать несколько агентов с разными профилями безопасности:

- Персональный ассистент с полным доступом
- Семейные/рабочие агенты с ограниченными инструментами
- Публичные агенты, работающие в песочницах

`setupCommand` относится к разделу `sandbox.docker` (глобально или для конкретного агента) и выполняется один раз
при создании контейнера.

Аутентификация — для каждого агента: каждый агент читает из собственного хранилища аутентификации `agentDir` по адресу:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Учетные данные **не** разделяются между агентами. Никогда не переиспользуйте `agentDir` между агентами.
Если требуется разделить учетные данные, скопируйте `auth-profiles.json` в `agentDir` другого агента.

О том, как работает sandboxing во время выполнения, см. [Sandboxing](/gateway/sandboxing).
Для отладки «почему это заблокировано?» см. [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) и `openclaw sandbox explain`.

---

## Примеры конфигурации

### Пример 1: Персональный агент + ограниченный семейный агент

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**Результат:**

- агент `main`: работает на хосте, полный доступ к инструментам
- агент `family`: работает в Docker (один контейнер на агента), только инструмент `read`

---

### Пример 2: Рабочий агент с общей песочницей

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### Пример 2b: Глобальный профиль для кодинга + агент только для сообщений

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**Результат:**

- агенты по умолчанию получают инструменты для кодинга
- агент `support` — только для сообщений (+ инструмент Slack)

---

### Пример 3: Разные режимы песочницы для каждого агента

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## Приоритет конфигурации

Когда существуют и глобальная (`agents.defaults.*`), и агент-специфичная (`agents.list[].*`) конфигурации:

### Конфигурация песочницы

Настройки конкретного агента переопределяют глобальные:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Примечания:**

- `agents.list[].sandbox.{docker,browser,prune}.*` переопределяет `agents.defaults.sandbox.{docker,browser,prune}.*` для данного агента (игнорируется, когда область песочницы разрешается в `"shared"`).

### Ограничения инструментов

Порядок фильтрации:

1. **Профиль инструментов** (`tools.profile` или `agents.list[].tools.profile`)
2. **Профиль инструментов провайдера** (`tools.byProvider[provider].profile` или `agents.list[].tools.byProvider[provider].profile`)
3. **Глобальная политика инструментов** (`tools.allow` / `tools.deny`)
4. **Политика инструментов провайдера** (`tools.byProvider[provider].allow/deny`)
5. **Политика инструментов для конкретного агента** (`agents.list[].tools.allow/deny`)
6. **Политика провайдера агента** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Политика инструментов песочницы** (`tools.sandbox.tools` или `agents.list[].tools.sandbox.tools`)
8. **Политика инструментов подагента** (`tools.subagents.tools`, если применимо)

Каждый уровень может дополнительно ограничивать инструменты, но не может вернуть доступ к инструментам, запрещенным на предыдущих уровнях.
Если задан `agents.list[].tools.sandbox.tools`, он заменяет `tools.sandbox.tools` для данного агента.
Если задан `agents.list[].tools.profile`, он переопределяет `tools.profile` для данного агента.
Ключи инструментов провайдера принимают либо `provider` (например, `google-antigravity`), либо `provider/model` (например, `openai/gpt-5.2`).

### Группы инструментов (сокращения)

Политики инструментов (глобальные, агентные, песочницы) поддерживают записи `group:*`, которые разворачиваются в несколько конкретных инструментов:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: все встроенные инструменты OpenClaw (исключая плагины провайдеров)

### Режим Elevated

`tools.elevated` — глобальная база (список разрешённых на основе отправителя). `agents.list[].tools.elevated` может дополнительно ограничивать elevated для конкретных агентов (должны разрешать оба).

Шаблоны смягчения рисков:

- Запретить `exec` для недоверенных агентов (`agents.list[].tools.deny: ["exec"]`)
- Избегать добавления в список разрешённых отправителей, которые маршрутизируют к ограниченным агентам
- Отключить elevated глобально (`tools.elevated.enabled: false`), если требуется только выполнение в песочнице
- Отключить elevated для конкретного агента (`agents.list[].tools.elevated.enabled: false`) для чувствительных профилей

---

## Миграция с одного агента

**До (один агент):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**После (многоагентная конфигурация с разными профилями):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Устаревшие конфигурации `agent.*` мигрируются с помощью `openclaw doctor`; в дальнейшем предпочтительно использовать `agents.defaults` + `agents.list`.

---

## Примеры ограничений инструментов

### Агент только для чтения

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Агент безопасного выполнения (без модификации файлов)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Агент только для коммуникаций

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Распространенный Питпад: "Неосновный"

`agents.defaults.sandbox.mode: "non-main"` основан на `session.mainKey` (по умолчанию `"main"`),
а не на идентификаторе агента. Сеансы групп/каналов всегда получают собственные ключи, поэтому
они считаются non-main и будут выполняться в песочнице. Если требуется, чтобы агент никогда
не использовал песочницу, задайте `agents.list[].sandbox.mode: "off"`.

---

## Тестирование

После настройки песочницы и инструментов для нескольких агентов:

1. **Проверьте разрешение агента:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Проверьте контейнеры песочницы:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Проверьте ограничения инструментов:**
   - Отправьте сообщение, требующее запрещённых инструментов
   - Убедитесь, что агент не может использовать запрещённые инструменты

4. **Мониторинг логов:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Устранение неполадок

### Агент не работает в песочнице, несмотря на `mode: "all"`

- Проверьте, нет ли глобального `agents.defaults.sandbox.mode`, который его переопределяет
- Конфигурация для конкретного агента имеет приоритет, поэтому задайте `agents.list[].sandbox.mode: "all"`

### Инструменты всё ещё доступны, несмотря на список запрета

- Проверьте порядок фильтрации инструментов: глобально → агент → песочница → подагент
- Каждый уровень может только дополнительно ограничивать, но не возвращать доступ
- Проверьте по логам: `[tools] filtering tools for agent:${agentId}`

### Контейнер не изолирован для каждого агента

- Задайте `scope: "agent"` в конфигурации песочницы для конкретного агента
- Значение по умолчанию — `"session"`, при котором создаётся один контейнер на сеанс

---

## См. также

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
