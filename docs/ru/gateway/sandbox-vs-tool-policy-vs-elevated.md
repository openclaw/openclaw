---
title: Sandbox vs Tool Policy vs Elevated
summary: "Почему инструмент блокируется: среда выполнения sandbox, политика разрешения/запрета инструментов и шлюзы elevated exec"
read_when: "«Вы столкнулись с “sandbox jail” или видите отказ инструмента/elevated и хотите узнать точный ключ конфига, который нужно изменить»."
status: active
---

# Sandbox vs Tool Policy vs Elevated

В OpenClaw есть три связанных (но разных) механизма управления:

1. **Sandbox** (`agents.defaults.sandbox.*` / `agents.list[].sandbox.*`) определяет **где запускаются инструменты** (Docker или хост).
2. **Tool policy** (`tools.*`, `tools.sandbox.tools.*`, `agents.list[].tools.*`) определяет **какие инструменты доступны/разрешены**.
3. **Elevated** (`tools.elevated.*`, `agents.list[].tools.elevated.*`) — это **исключительно exec-механизм обхода**, позволяющий запускаться на хосте при работе в sandbox.

## Быстрая отладка

Используйте инспектор, чтобы увидеть, что OpenClaw _фактически_ делает:

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

Он выводит:

- эффективный режим sandbox / область действия / доступ к рабочему пространству
- находится ли сеанс в данный момент в sandbox (main vs non-main)
- эффективный allow/deny инструментов sandbox (и откуда он пришёл: agent/global/default)
- шлюзы elevated и пути ключей «fix-it»

## Sandbox: где запускаются инструменты

Sandboxing управляется ключом `agents.defaults.sandbox.mode`:

- `"off"`: всё выполняется на хосте.
- `"non-main"`: в sandbox попадают только non-main сеансы (частый «сюрприз» для групп/каналов).
- `"all"`: всё выполняется в sandbox.

Полную матрицу (область действия, монтирование рабочих пространств, образы) см. в разделе [Sandboxing](/gateway/sandboxing).

### Bind mounts (быстрая проверка безопасности)

- `docker.binds` _пробивает_ файловую систему sandbox: всё, что вы монтируете, становится видимым внутри контейнера с указанным режимом (`:ro` или `:rw`).
- По умолчанию используется режим read-write, если режим не указан; для исходников/секретов предпочтительнее `:ro`.
- `scope: "shared"` игнорирует per-agent монтирования (применяются только глобальные).
- Монтирование `/var/run/docker.sock` фактически передаёт контроль над хостом sandbox; делайте это только осознанно.
- Доступ к рабочему пространству (`workspaceAccess: "ro"`/`"rw"`) не зависит от режимов bind.

## Tool policy: какие инструменты существуют/могут вызываться

Два слоя имеют значение:

- **Профиль инструментов**: `tools.profile` и `agents.list[].tools.profile` (базовый список разрешённых)
- **Профиль инструментов провайдера**: `tools.byProvider[provider].profile` и `agents.list[].tools.byProvider[provider].profile`
- **Глобальная/per-agent политика инструментов**: `tools.allow`/`tools.deny` и `agents.list[].tools.allow`/`agents.list[].tools.deny`
- **Политика инструментов провайдера**: `tools.byProvider[provider].allow/deny` и `agents.list[].tools.byProvider[provider].allow/deny`
- **Политика инструментов sandbox** (применяется только при работе в sandbox): `tools.sandbox.tools.allow`/`tools.sandbox.tools.deny` и `agents.list[].tools.sandbox.tools.*`

Практические правила:

- `deny` всегда имеет приоритет.
- Если `allow` не пуст, всё остальное считается заблокированным.
- Политика инструментов — это жёсткая точка остановки: `/exec` не может переопределить запрещённый инструмент `exec`.
- `/exec` лишь меняет значения по умолчанию сеанса для авторизованных отправителей; доступ к инструментам он не предоставляет.
  Ключи инструментов провайдера принимают либо `provider` (например, `google-antigravity`), либо `provider/model` (например, `openai/gpt-5.2`).

### Группы инструментов (сокращения)

Политики инструментов (global, agent, sandbox) поддерживают записи `group:*`, которые разворачиваются в несколько инструментов:

```json5
{
  tools: {
    sandbox: {
      tools: {
        allow: ["group:runtime", "group:fs", "group:sessions", "group:memory"],
      },
    },
  },
}
```

Доступные группы:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: все встроенные инструменты OpenClaw (исключая плагины провайдеров)

## Elevated: exec-only «запуск на хосте»

Elevated **не** предоставляет дополнительных инструментов; он влияет только на `exec`.

- Если вы работаете в sandbox, `/elevated on` (или `exec` с `elevated: true`) выполняется на хосте (подтверждения всё ещё могут требоваться).
- Используйте `/elevated full`, чтобы пропустить подтверждения exec для сеанса.
- Если вы уже работаете напрямую, elevated фактически является no-op (но всё равно проходит через шлюзы).
- Elevated **не** имеет привязки к Skills и **не** переопределяет allow/deny инструментов.
- `/exec` отделён от elevated. Он лишь настраивает per-session значения по умолчанию exec для авторизованных отправителей.

Шлюзы:

- Включение: `tools.elevated.enabled` (и при необходимости `agents.list[].tools.elevated.enabled`)
- Allowlist отправителей: `tools.elevated.allowFrom.<provider>` (и при необходимости `agents.list[].tools.elevated.allowFrom.<provider>`)

См. [Elevated Mode](/tools/elevated).

## Распространённые исправления «sandbox jail»

### «Инструмент X заблокирован политикой инструментов sandbox»

Ключи для исправления (выберите один):

- Отключить sandbox: `agents.defaults.sandbox.mode=off` (или per-agent `agents.list[].sandbox.mode=off`)
- Разрешить инструмент внутри sandbox:
  - удалить его из `tools.sandbox.tools.deny` (или per-agent `agents.list[].tools.sandbox.tools.deny`)
  - или добавить его в `tools.sandbox.tools.allow` (или per-agent allow)

### «Я думал, что это main — почему он в sandbox?»

В режиме `"non-main"` ключи групп/каналов _не_ являются main. Используйте ключ main-сеанса (показывается в `sandbox explain`) или переключите режим на `"off"`.
