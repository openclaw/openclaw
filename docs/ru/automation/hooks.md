---
summary: "Hooks: событийно-ориентированная автоматизация для команд и событий жизненного цикла"
read_when:
  - Вам нужна событийно-ориентированная автоматизация для /new, /reset, /stop и событий жизненного цикла агента
  - Вы хотите создавать, устанавливать или отлаживать hooks
title: "Hooks"
---

# Hooks

Hooks предоставляют расширяемую событийно-ориентированную систему для автоматизации действий в ответ на команды агента и события. Hooks автоматически обнаруживаются в каталогах и могут управляться через CLI-команды — аналогично тому, как работают Skills в OpenClaw.

## Getting Oriented

Hooks — это небольшие скрипты, которые выполняются, когда что‑то происходит. Существует два вида:

- **Hooks** (эта страница): выполняются внутри Gateway (шлюза), когда срабатывают события агента, такие как `/new`, `/reset`, `/stop` или события жизненного цикла.
- **Webhooks**: внешние HTTP-вебхуки, которые позволяют запускать другие системы в OpenClaw. См. [Webhook Hooks](/automation/webhook) или используйте `openclaw webhooks` для вспомогательных команд Gmail.

Hooks также могут быть включены в плагины; см. [Plugins](/tools/plugin#plugin-hooks).

Типичные сценарии использования:

- Сохранение снимка памяти при сбросе сеанса
- Ведение аудиторского журнала команд для отладки или соответствия требованиям
- Запуск последующей автоматизации при начале или завершении сеанса
- Запись файлов в рабочее пространство агента или вызов внешних API при срабатывании событий

Если вы можете написать небольшую функцию на TypeScript, вы можете написать hook. Hooks обнаруживаются автоматически, а включение и отключение выполняется через CLI.

## Overview

Система hooks позволяет:

- Сохранять контекст сеанса в память при выполнении `/new`
- Логировать все команды для аудита
- Запускать пользовательскую автоматизацию на событиях жизненного цикла агента
- Расширять поведение OpenClaw без изменения кода ядра

## Getting Started

### Bundled Hooks

OpenClaw поставляется с четырьмя встроенными hooks, которые обнаруживаются автоматически:

- **💾 session-memory**: сохраняет контекст сеанса в рабочее пространство агента (по умолчанию `~/.openclaw/workspace/memory/`) при выполнении `/new`
- **📝 command-logger**: логирует все события команд в `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: запускает `BOOT.md` при старте Gateway (шлюза) (требуются включённые внутренние hooks)
- **😈 soul-evil**: подменяет внедрённый контент `SOUL.md` на `SOUL_EVIL.md` в период очистки или со случайной вероятностью

Список доступных hooks:

```bash
openclaw hooks list
```

Включить hook:

```bash
openclaw hooks enable session-memory
```

Проверить статус hook:

```bash
openclaw hooks check
```

Получить подробную информацию:

```bash
openclaw hooks info session-memory
```

### Onboarding

Во время онбординга (`openclaw onboard`) вам будет предложено включить рекомендуемые hooks. Мастер автоматически обнаруживает подходящие hooks и предлагает их для выбора.

## Hook Discovery

Hooks автоматически обнаруживаются из трёх каталогов (в порядке приоритета):

1. **Workspace hooks**: `<workspace>/hooks/` (для каждого агента, наивысший приоритет)
2. **Managed hooks**: `~/.openclaw/hooks/` (установленные пользователем, общие для рабочих пространств)
3. **Bundled hooks**: `<openclaw>/dist/hooks/bundled/` (поставляются с OpenClaw)

Каталоги managed hooks могут содержать либо **один hook**, либо **набор hooks** (каталог пакета).

Каждый hook — это каталог, содержащий:

```
my-hook/
├── HOOK.md          # Metadata + documentation
└── handler.ts       # Handler implementation
```

## Hook Packs (npm/archives)

Наборы hooks — это стандартные npm‑пакеты, которые экспортируют один или несколько hooks через `openclaw.hooks` в
`package.json`. Устанавливаются так:

```bash
openclaw hooks install <path-or-spec>
```

Пример `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Каждая запись указывает на каталог hook, содержащий `HOOK.md` и `handler.ts` (или `index.ts`).
Наборы hooks могут включать зависимости; они будут установлены в `~/.openclaw/hooks/<id>`.

## Hook Structure

### Формат HOOK.md

Файл `HOOK.md` содержит метаданные в YAML frontmatter и документацию в Markdown:

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### Поля метаданных

Объект `metadata.openclaw` поддерживает:

- **`emoji`**: отображаемый emoji для CLI (например, `"💾"`)
- **`events`**: массив событий для подписки (например, `["command:new", "command:reset"]`)
- **`export`**: именованный экспорт для использования (по умолчанию `"default"`)
- **`homepage`**: URL документации
- **`requires`**: необязательные требования
  - **`bins`**: требуемые бинарные файлы в PATH (например, `["git", "node"]`)
  - **`anyBins`**: должен присутствовать хотя бы один из этих бинарных файлов
  - **`env`**: требуемые переменные окружения
  - **`config`**: требуемые пути конфига (например, `["workspace.dir"]`)
  - **`os`**: требуемые платформы (например, `["darwin", "linux"]`)
- **`always`**: обход проверок пригодности (boolean)
- **`install`**: способы установки (для встроенных hooks: `[{"id":"bundled","kind":"bundled"}]`)

### Реализация обработчика

Файл `handler.ts` экспортирует функцию `HookHandler`:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### Контекст события

Каждое событие включает:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // e.g., 'new', 'reset', 'stop'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Event Types

### События команд

Срабатывают при выполнении команд агента:

- **`command`**: все события команд (общий слушатель)
- **`command:new`**: при выполнении команды `/new`
- **`command:reset`**: при выполнении команды `/reset`
- **`command:stop`**: при выполнении команды `/stop`

### События агента

- **`agent:bootstrap`**: перед внедрением файлов инициализации рабочего пространства (hooks могут изменять `context.bootstrapFiles`)

### События Gateway (шлюза)

Срабатывают при запуске Gateway (шлюза):

- **`gateway:startup`**: после запуска каналов и загрузки hooks

### Hooks результатов инструментов (API плагинов)

Эти hooks не являются слушателями потока событий; они позволяют плагинам синхронно изменять результаты инструментов до того, как OpenClaw сохранит их.

- **`tool_result_persist`**: преобразует результаты инструментов перед записью в транскрипт сеанса. Должен быть синхронным; верните обновлённую полезную нагрузку результата инструмента или `undefined`, чтобы оставить без изменений. См. [Agent Loop](/concepts/agent-loop).

### Будущие события

Запланированные типы событий:

- **`session:start`**: при начале нового сеанса
- **`session:end`**: при завершении сеанса
- **`agent:error`**: при возникновении ошибки у агента
- **`message:sent`**: при отправке сообщения
- **`message:received`**: при получении сообщения

## Creating Custom Hooks

### 1. Выбор расположения

- **Workspace hooks** (`<workspace>/hooks/`): для каждого агента, наивысший приоритет
- **Managed hooks** (`~/.openclaw/hooks/`): общие для рабочих пространств

### 2. Создание структуры каталогов

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Создание HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. Создание handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // Your logic here
};

export default handler;
```

### 5. Включение и тестирование

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## Configuration

### Новый формат конфига (рекомендуется)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Конфигурация Per-Hook

Hooks могут иметь собственную конфигурацию:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Дополнительные каталоги

Загрузка hooks из дополнительных каталогов:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Устаревший формат конфига (всё ещё поддерживается)

Старый формат конфига продолжает работать для обратной совместимости:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

**Миграция**: для новых hooks используйте систему обнаружения на основе каталогов. Устаревшие обработчики загружаются после hooks, обнаруженных по каталогам.

## CLI Commands

### Список hooks

```bash
# List all hooks
openclaw hooks list

# Show only eligible hooks
openclaw hooks list --eligible

# Verbose output (show missing requirements)
openclaw hooks list --verbose

# JSON output
openclaw hooks list --json
```

### Информация о hook

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### Проверка пригодности

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### Включить/выключить

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## Bundled hook reference

### session-memory

Сохраняет контекст сеанса в память при выполнении `/new`.

**События**: `command:new`

**Требования**: должен быть настроен `workspace.dir`

**Вывод**: `<workspace>/memory/YYYY-MM-DD-slug.md` (по умолчанию `~/.openclaw/workspace`)

**Что делает**:

1. Использует запись сеанса до сброса, чтобы найти корректный транскрипт
2. Извлекает последние 15 строк диалога
3. Использует LLM для генерации описательного slug имени файла
4. Сохраняет метаданные сеанса в файл памяти с датой

**Пример вывода**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Примеры имён файлов**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (резервная временная метка, если генерация slug не удалась)

**Включить**:

```bash
openclaw hooks enable session-memory
```

### command-logger

Логирует все события команд в централизованный аудиторский файл.

**События**: `command`

**Требования**: отсутствуют

**Вывод**: `~/.openclaw/logs/commands.log`

**Что делает**:

1. Захватывает детали события (действие команды, временную метку, ключ сеанса, ID отправителя, источник)
2. Добавляет запись в лог-файл в формате JSONL
3. Работает бесшумно в фоновом режиме

**Примеры записей лога**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Просмотр логов**:

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Включить**:

```bash
openclaw hooks enable command-logger
```

### soul-evil

Подменяет внедрённый контент `SOUL.md` на `SOUL_EVIL.md` в период очистки или со случайной вероятностью.

**События**: `agent:bootstrap`

**Документация**: [SOUL Evil Hook](/hooks/soul-evil)

**Вывод**: файлы не создаются; подмена выполняется только в памяти.

**Включить**:

```bash
openclaw hooks enable soul-evil
```

**Конфиг**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

Запускает `BOOT.md` при старте Gateway (шлюза) (после запуска каналов).
Для выполнения должны быть включены внутренние hooks.

**События**: `gateway:startup`

**Требования**: должен быть настроен `workspace.dir`

**Что делает**:

1. Читает `BOOT.md` из вашего рабочего пространства
2. Выполняет инструкции через runner агента
3. Отправляет любые запрошенные исходящие сообщения через инструмент сообщений

**Включить**:

```bash
openclaw hooks enable boot-md
```

## Best Practices

### Делайте обработчики быстрыми

Hooks выполняются во время обработки команд. Держите их лёгкими:

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Корректно обрабатывайте ошибки

Всегда оборачивайте рискованные операции:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### Раннее фильтрование событий

Возвращайтесь раньше, если событие не относится к делу:

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### Используйте конкретные ключи событий

По возможности указывайте точные события в метаданных:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

Вместо:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## Debugging

### Включение логирования hooks

Gateway (шлюз) логирует загрузку hooks при запуске:

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Проверка обнаружения

Выведите список всех обнаруженных hooks:

```bash
openclaw hooks list --verbose
```

### Проверка регистрации

В обработчике логируйте момент его вызова:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### Проверка пригодности

Узнайте, почему hook не пригоден:

```bash
openclaw hooks info my-hook
```

Ищите отсутствующие требования в выводе.

## Testing

### Логи Gateway (шлюза)

Отслеживайте логи Gateway (шлюза), чтобы видеть выполнение hooks:

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### Тестирование hooks напрямую

Тестируйте обработчики изолированно:

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Assert side effects
});
```

## Architecture

### Core Components

- **`src/hooks/types.ts`**: определения типов
- **`src/hooks/workspace.ts`**: сканирование каталогов и загрузка
- **`src/hooks/frontmatter.ts`**: разбор метаданных HOOK.md
- **`src/hooks/config.ts`**: проверка пригодности
- **`src/hooks/hooks-status.ts`**: отчёт о статусе
- **`src/hooks/loader.ts`**: динамический загрузчик модулей
- **`src/cli/hooks-cli.ts`**: CLI‑команды
- **`src/gateway/server-startup.ts`**: загрузка hooks при старте Gateway (шлюза)
- **`src/auto-reply/reply/commands-core.ts`**: генерация событий команд

### Discovery Flow

```
Gateway startup
    ↓
Scan directories (workspace → managed → bundled)
    ↓
Parse HOOK.md files
    ↓
Check eligibility (bins, env, config, os)
    ↓
Load handlers from eligible hooks
    ↓
Register handlers for events
```

### Event Flow

```
User sends /new
    ↓
Command validation
    ↓
Create hook event
    ↓
Trigger hook (all registered handlers)
    ↓
Command processing continues
    ↓
Session reset
```

## Troubleshooting

### Hook не обнаружен

1. Проверьте структуру каталогов:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. Проверьте формат HOOK.md:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. Выведите список всех обнаруженных hooks:

   ```bash
   openclaw hooks list
   ```

### Hook не пригоден

Проверьте требования:

```bash
openclaw hooks info my-hook
```

Ищите отсутствующее:

- бинарные файлы (проверьте PATH)
- переменные окружения
- значения конфига
- совместимость с ОС

### Hook не выполняется

1. Убедитесь, что hook включён:

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. Перезапустите процесс Gateway (шлюза), чтобы hooks перезагрузились.

3. Проверьте логи Gateway (шлюза) на наличие ошибок:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Ошибки обработчика

Проверьте ошибки TypeScript/импорта:

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Migration Guide

### С устаревшего конфига на обнаружение

**До**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**После**:

1. Создайте каталог hook:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Создайте HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. Обновите конфиг:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. Проверьте и перезапустите процесс Gateway (шлюза):

   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**Преимущества миграции**:

- Автоматическое обнаружение
- Управление через CLI
- Проверка пригодности
- Лучшая документация
- Единая структура

## See Also

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
