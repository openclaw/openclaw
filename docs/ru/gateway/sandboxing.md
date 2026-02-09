---
summary: "Как работает sandboxing в OpenClaw: режимы, области, доступ к рабочему пространству и образы"
title: Sandboxing
read_when: "Вам нужно отдельное объяснение sandboxing или требуется настроить agents.defaults.sandbox."
status: active
---

# Sandboxing

OpenClaw может запускать **инструменты внутри Docker‑контейнеров**, чтобы уменьшить радиус поражения.
Это **необязательно** и управляется конфигурацией (`agents.defaults.sandbox` или
`agents.list[].sandbox`). Если sandboxing отключён, инструменты выполняются на хосте.
Gateway остаётся на хосте; выполнение инструментов при включении происходит
в изолированном sandbox.

Это не идеальная граница безопасности, но она существенно ограничивает доступ
к файловой системе и процессам, когда модель делает что‑то неразумное.

## Что получает песочницу

- Выполнение инструментов (`exec`, `read`, `write`, `edit`, `apply_patch`, `process` и т. д.).
- Необязательный sandboxed‑браузер (`agents.defaults.sandbox.browser`).
  - По умолчанию браузер в sandbox автоматически запускается (гарантирует доступность CDP), когда он требуется инструменту браузера.
    Настройка через `agents.defaults.sandbox.browser.autoStart` и `agents.defaults.sandbox.browser.autoStartTimeoutMs`.
  - `agents.defaults.sandbox.browser.allowHostControl` позволяет sandbox‑сеансам явно нацеливаться на браузер хоста.
  - Необязательные allowlist‑ы ограничивают `target: "custom"`: `allowedControlUrls`, `allowedControlHosts`, `allowedControlPorts`.

Не песочница:

- Сам процесс Gateway.
- Любой инструмент, явно разрешённый к запуску на хосте (например, `tools.elevated`).
  - **Выполнение с повышенными правами выполняется на хосте и обходит sandboxing.**
  - Если sandboxing отключён, `tools.elevated` не меняет выполнение (оно уже на хосте). См. [Elevated Mode](/tools/elevated).

## Режимы

`agents.defaults.sandbox.mode` управляет **когда** используется sandboxing:

- `"off"`: без sandboxing.
- `"non-main"`: sandbox только для **неосновных** сеансов (по умолчанию, если вы хотите обычные чаты на хосте).
- `"all"`: каждый сеанс запускается в sandbox.
  Примечание: `"non-main"` основано на `session.mainKey` (по умолчанию `"main"`), а не на id агента.
  Групповые/канальные сеансы используют собственные ключи, поэтому считаются неосновными и будут изолированы.

## Область

`agents.defaults.sandbox.scope` управляет **сколькими контейнерами** создаётся:

- `"session"` (по умолчанию): один контейнер на сеанс.
- `"agent"`: один контейнер на агента.
- `"shared"`: один контейнер, общий для всех изолированных сеансов.

## Доступ к рабочему пространству

`agents.defaults.sandbox.workspaceAccess` управляет **тем, что видит sandbox**:

- `"none"` (по умолчанию): инструменты видят рабочее пространство sandbox под `~/.openclaw/sandboxes`.
- `"ro"`: монтирует рабочее пространство агента только для чтения в `/agent` (отключает `write`/`edit`/`apply_patch`).
- `"rw"`: монтирует рабочее пространство агента для чтения/записи в `/workspace`.

Входящие медиа копируются в активное рабочее пространство sandbox (`media/inbound/*`).
Примечание по Skills: инструмент `read` привязан к корню sandbox. С `workspaceAccess: "none"`
OpenClaw зеркалирует подходящие skills в рабочее пространство sandbox (`.../skills`), чтобы
их можно было читать. С `"rw"` skills рабочего пространства доступны для чтения из
`/workspace/skills`.

## Пользовательские bind‑монтирования

`agents.defaults.sandbox.docker.binds` монтирует дополнительные каталоги хоста в контейнер.
Формат: `host:container:mode` (например, `"/home/user/source:/source:rw"`).

Глобальные и per‑agent бинды **объединяются** (а не заменяются). При `scope: "shared"` per‑agent бинды игнорируются.

Пример (источник только для чтения + docker socket):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: ["/home/user/source:/source:ro", "/var/run/docker.sock:/var/run/docker.sock"],
        },
      },
    },
    list: [
      {
        id: "build",
        sandbox: {
          docker: {
            binds: ["/mnt/cache:/cache:rw"],
          },
        },
      },
    ],
  },
}
```

Примечания по безопасности:

- Бинды обходят файловую систему sandbox: они открывают пути хоста с указанным вами режимом (`:ro` или `:rw`).
- Чувствительные монтирования (например, `docker.sock`, секреты, SSH‑ключи) должны быть `:ro`, если только это не абсолютно необходимо.
- Комбинируйте с `workspaceAccess: "ro"`, если нужен только доступ на чтение к рабочему пространству; режимы биндов остаются независимыми.
- См. [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) о том, как бинды взаимодействуют с политикой инструментов и повышенным выполнением.

## Образы + настройка

Образ по умолчанию: `openclaw-sandbox:bookworm-slim`

Соберите его один раз:

```bash
scripts/sandbox-setup.sh
```

Примечание: образ по умолчанию **не** включает Node. Если skill требуется Node (или
другие рантаймы), либо запеките пользовательский образ, либо установите через
`sandbox.docker.setupCommand` (требуется сетевой выход + записываемый корень +
пользователь root).

Образ sandboxed‑браузера:

```bash
scripts/sandbox-browser-setup.sh
```

По умолчанию контейнеры sandbox запускаются **без сети**.
Переопределите с помощью `agents.defaults.sandbox.docker.network`.

Установки Docker и контейнеризованный Gateway находятся здесь:
[Docker](/install/docker)

## setupCommand (одноразовая настройка контейнера)

`setupCommand` выполняется **один раз** после создания контейнера sandbox (не при каждом запуске).
Команда выполняется внутри контейнера через `sh -lc`.

Пути:

- Глобально: `agents.defaults.sandbox.docker.setupCommand`
- Per‑agent: `agents.list[].sandbox.docker.setupCommand`

Обычные ловушки:

- Значение `docker.network` по умолчанию — `"none"` (без egress), поэтому установка пакетов не сработает.
- `readOnlyRoot: true` запрещает запись; установите `readOnlyRoot: false` или запеките пользовательский образ.
- `user` должен быть root для установки пакетов (уберите `user` или установите `user: "0:0"`).
- Выполнение в sandbox **не** наследует хостовые `process.env`. Используйте
  `agents.defaults.sandbox.docker.env` (или пользовательский образ) для ключей API skills.

## Политика инструментов + «аварийные выходы»

Политики allow/deny для инструментов по‑прежнему применяются до правил sandbox. Если инструмент запрещён
глобально или для агента, sandboxing его не вернёт.

`tools.elevated` — это явный «аварийный выход», который запускает `exec` на хосте.
Директивы `/exec` применяются только для авторизованных отправителей и сохраняются на сеанс; чтобы жёстко отключить
`exec`, используйте запрет в политике инструментов (см. [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)).

Отладка:

- Используйте `openclaw sandbox explain`, чтобы проверить эффективный режим sandbox, политику инструментов и ключи конфигурации fix‑it.
- [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) для ментальной модели «почему это заблокировано?».
  Держите всё жёстко закрытым.

## Переопределения для мультиагентности

Каждый агент может переопределять sandbox + инструменты:
`agents.list[].sandbox` и `agents.list[].tools` (плюс `agents.list[].tools.sandbox.tools` для политики инструментов sandbox).
О приоритетах см. [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools).

## Минимальный пример включения

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
      },
    },
  },
}
```

## Связанная документация

- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)
- [Security](/gateway/security)
