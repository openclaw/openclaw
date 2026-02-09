---
summary: "Необязательная настройка и онбординг OpenClaw на базе Docker"
read_when:
  - Вам нужен контейнеризованный шлюз вместо локальных установок
  - Вы проверяете поток работы с Docker
title: "Docker"
---

# Docker (необязательно)

Docker — **необязателен**. Используйте его только если вам нужен контейнеризованный Gateway (шлюз) или вы хотите проверить поток работы с Docker.

## Подходит ли мне Docker?

- **Да**: вам нужна изолированная, одноразовая среда Gateway (шлюз) или вы хотите запускать OpenClaw на хосте без локальных установок.
- **Нет**: вы работаете на своей машине и просто хотите самый быстрый цикл разработки. В этом случае используйте обычный процесс установки.
- **Примечание по sandboxing**: sandboxing агентов тоже использует Docker, но **не** требует запуска всего Gateway (шлюз) в Docker. См. [Sandboxing](/gateway/sandboxing).

Это руководство охватывает:

- Контейнеризованный Gateway (шлюз) (полный OpenClaw в Docker)
- Sandbox агента на сеанс (Gateway (шлюз) на хосте + инструменты агента, изолированные Docker)

Подробности по sandboxing: [Sandboxing](/gateway/sandboxing)

## Требования

- Docker Desktop (или Docker Engine) + Docker Compose v2
- Достаточно дискового пространства для образов и логов

## Контейнеризованный Gateway (шлюз) (Docker Compose)

### Быстрый старт (рекомендуется)

Из корня репозитория:

```bash
./docker-setup.sh
```

Этот скрипт:

- собирает образ Gateway (шлюз)
- запускает мастер онбординга
- выводит подсказки по настройке провайдера
- запускает Gateway (шлюз) через Docker Compose
- генерирует токен Gateway (шлюз) и записывает его в `.env`

Необязательные env vars:

- `OPENCLAW_DOCKER_APT_PACKAGES` — установить дополнительные пакеты apt во время сборки
- `OPENCLAW_EXTRA_MOUNTS` — добавить дополнительные bind-монты хоста
- `OPENCLAW_HOME_VOLUME` — сохранять `/home/node` в именованном томе

После завершения:

- Откройте `http://127.0.0.1:18789/` в браузере.
- Вставьте токен в Control UI (Settings → token).
- Нужно снова получить URL? Запустите `docker compose run --rm openclaw-cli dashboard --no-open`.

Конфиг/рабочее пространство записываются на хост:

- `~/.openclaw/`
- `~/.openclaw/workspace`

Запуск на VPS? См. [Hetzner (Docker VPS)](/install/hetzner).

### Ручной процесс (compose)

```bash
docker build -t openclaw:local -f Dockerfile .
docker compose run --rm openclaw-cli onboard
docker compose up -d openclaw-gateway
```

Примечание: запускайте `docker compose ...` из корня репозитория. Если вы включили
`OPENCLAW_EXTRA_MOUNTS` или `OPENCLAW_HOME_VOLUME`, скрипт настройки записывает
`docker-compose.extra.yml`; подключите его при запуске Compose в другом месте:

```bash
docker compose -f docker-compose.yml -f docker-compose.extra.yml <command>
```

### Токен Control UI + сопряжение (Docker)

Если вы видите «unauthorized» или «disconnected (1008): pairing required», получите
свежую ссылку на панель и одобрите устройство браузера:

```bash
docker compose run --rm openclaw-cli dashboard --no-open
docker compose run --rm openclaw-cli devices list
docker compose run --rm openclaw-cli devices approve <requestId>
```

Подробнее: [Dashboard](/web/dashboard), [Devices](/cli/devices).

### Дополнительные монтирования (необязательно)

Если вы хотите смонтировать дополнительные каталоги хоста в контейнеры, установите
`OPENCLAW_EXTRA_MOUNTS` перед запуском `docker-setup.sh`. Принимается
список Docker bind-монтов, разделённых запятыми, который применяется к
`openclaw-gateway` и `openclaw-cli` путём генерации `docker-compose.extra.yml`.

Пример:

```bash
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Примечания:

- Пути должны быть расшарены с Docker Desktop на macOS/Windows.
- Если вы редактируете `OPENCLAW_EXTRA_MOUNTS`, повторно запустите `docker-setup.sh`, чтобы
  пересоздать дополнительный compose-файл.
- `docker-compose.extra.yml` генерируется автоматически. Не редактируйте его вручную.

### Сохранение всего home контейнера (необязательно)

Если вы хотите, чтобы `/home/node` сохранялся при пересоздании контейнера, задайте
именованный том через `OPENCLAW_HOME_VOLUME`. Это создаёт Docker-том и монтирует его в
`/home/node`, сохраняя стандартные bind-монты для конфига/рабочего пространства. Используйте здесь именованный том (а не bind-путь); для bind-монтов используйте
`OPENCLAW_EXTRA_MOUNTS`.

Пример:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

Это можно комбинировать с дополнительными монтированиями:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
export OPENCLAW_EXTRA_MOUNTS="$HOME/.codex:/home/node/.codex:ro,$HOME/github:/home/node/github:rw"
./docker-setup.sh
```

Примечания:

- Если вы измените `OPENCLAW_HOME_VOLUME`, повторно запустите `docker-setup.sh`, чтобы
  пересоздать дополнительный compose-файл.
- Именованный том сохраняется до удаления командой `docker volume rm <name>`.

### Установка дополнительных пакетов apt (необязательно)

Если вам нужны системные пакеты внутри образа (например, инструменты сборки или
медиабиблиотеки), установите `OPENCLAW_DOCKER_APT_PACKAGES` перед запуском `docker-setup.sh`.
Пакеты устанавливаются во время сборки образа, поэтому сохраняются даже при удалении
контейнера.

Пример:

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="ffmpeg build-essential"
./docker-setup.sh
```

Примечания:

- Принимается список имён пакетов apt, разделённых пробелами.
- Если вы измените `OPENCLAW_DOCKER_APT_PACKAGES`, повторно запустите `docker-setup.sh`, чтобы
  пересобрать образ.

### Для опытных пользователей / полнофункциональный контейнер (opt-in)

Образ Docker по умолчанию ориентирован на **безопасность** и запускается от
непривилегированного пользователя `node`. Это уменьшает поверхность атаки,
но означает:

- отсутствие установки системных пакетов во время выполнения
- отсутствие Homebrew по умолчанию
- отсутствие встроенных браузеров Chromium/Playwright

Если вам нужен более полнофункциональный контейнер, используйте следующие opt-in
настройки:

1. **Сохранять `/home/node`**, чтобы загрузки браузеров и кэши инструментов
   сохранялись:

```bash
export OPENCLAW_HOME_VOLUME="openclaw_home"
./docker-setup.sh
```

2. **Запекать системные зависимости в образ** (воспроизводимо и постоянно):

```bash
export OPENCLAW_DOCKER_APT_PACKAGES="git curl jq"
./docker-setup.sh
```

3. **Устанавливать браузеры Playwright без `npx`** (избегает конфликтов
   переопределений npm):

```bash
docker compose run --rm openclaw-cli \
  node /app/node_modules/playwright-core/cli.js install chromium
```

Если Playwright требуется установка системных зависимостей, пересоберите образ с
`OPENCLAW_DOCKER_APT_PACKAGES` вместо использования `--with-deps` во время выполнения.

4. **Сохранять загрузки браузеров Playwright**:

- Установите `PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright` в
  `docker-compose.yml`.
- Убедитесь, что `/home/node` сохраняется через `OPENCLAW_HOME_VOLUME`, или смонтируйте
  `/home/node/.cache/ms-playwright` через `OPENCLAW_EXTRA_MOUNTS`.

### Права доступа + EACCES

Образ запускается от пользователя `node` (uid 1000). Если вы видите ошибки
прав доступа на `/home/node/.openclaw`, убедитесь, что ваши bind-монты на хосте принадлежат
uid 1000.

Пример (хост Linux):

```bash
sudo chown -R 1000:1000 /path/to/openclaw-config /path/to/openclaw-workspace
```

Если вы решите запускаться от root для удобства, вы принимаете компромисс по
безопасности.

### Более быстрые пересборки (рекомендуется)

Чтобы ускорить пересборки, упорядочьте Dockerfile так, чтобы слои зависимостей
кешировались.
Это позволяет не перезапускать `pnpm install`, пока не изменятся
lock-файлы:

```dockerfile
FROM node:22-bookworm

# Install Bun (required for build scripts)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /app

# Cache dependencies unless package metadata changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

### Настройка каналов (необязательно)

Используйте контейнер CLI для настройки каналов, затем при необходимости перезапустите
Gateway (шлюз).

WhatsApp (QR):

```bash
docker compose run --rm openclaw-cli channels login
```

Telegram (токен бота):

```bash
docker compose run --rm openclaw-cli channels add --channel telegram --token "<token>"
```

Discord (токен бота):

```bash
docker compose run --rm openclaw-cli channels add --channel discord --token "<token>"
```

Документация: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord)

### OpenAI Codex OAuth (headless Docker)

Если в мастере вы выберете OpenAI Codex OAuth, он откроет URL в браузере и попытается
принять callback на `http://127.0.0.1:1455/auth/callback`. В Docker или headless-настройках этот callback
может показать ошибку браузера. Скопируйте полный URL редиректа, на который вы
попадаете, и вставьте его обратно в мастер, чтобы завершить аутентификацию.

### Проверка здоровья

```bash
docker compose exec openclaw-gateway node dist/index.js health --token "$OPENCLAW_GATEWAY_TOKEN"
```

### E2E smoke-тест (Docker)

```bash
scripts/e2e/onboard-docker.sh
```

### Smoke-тест импорта QR (Docker)

```bash
pnpm test:docker:qr
```

### Примечания

- Привязка Gateway (шлюз) по умолчанию — `lan` для использования в контейнере.
- CMD в Dockerfile использует `--allow-unconfigured`; смонтированный конфиг с
  `gateway.mode`, а не `local`, всё равно запустится. Переопределите CMD,
  чтобы принудительно включить проверку.
- Контейнер Gateway (шлюз) является источником истины для сеансов (`~/.openclaw/agents/<agentId>/sessions/`).

## Sandbox агента (Gateway (шлюз) на хосте + инструменты Docker)

Подробный разбор: [Sandboxing](/gateway/sandboxing)

### Что он делает

Когда включён `agents.defaults.sandbox`, **неосновные сеансы** выполняют инструменты внутри
Docker-контейнера. Gateway (шлюз) остаётся на вашем хосте, но выполнение инструментов
изолировано:

- область: `"agent"` по умолчанию (один контейнер + рабочее пространство на агента)
- область: `"session"` для изоляции по сеансам
- рабочая папка на область, смонтированная в `/workspace`
- необязательный доступ агента к рабочему пространству (`agents.defaults.sandbox.workspaceAccess`)
- политика разрешения/запрета инструментов (запрет имеет приоритет)
- входящие медиа копируются в активное рабочее пространство sandbox (`media/inbound/*`),
  чтобы инструменты могли их читать (с `workspaceAccess: "rw"` это попадает в рабочее
  пространство агента)

Предупреждение: `scope: "shared"` отключает межсеансовую изоляцию. Все сеансы делят
один контейнер и одно рабочее пространство.

### Профили sandbox на агента (multi-agent)

Если вы используете маршрутизацию multi-agent, каждый агент может переопределять
настройки sandbox и инструментов: `agents.list[].sandbox` и `agents.list[].tools` (плюс
`agents.list[].tools.sandbox.tools`). Это позволяет запускать смешанные уровни доступа в одном Gateway
(шлюзе):

- Полный доступ (личный агент)
- Инструменты только для чтения + рабочее пространство только для чтения
  (семейный/рабочий агент)
- Без инструментов файловой системы/оболочки (публичный агент)

[Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools) для примеров,
приоритетов и устранения неполадок.

### Поведение по умолчанию

- Образ: `openclaw-sandbox:bookworm-slim`
- Один контейнер на агента
- Доступ агента к рабочему пространству: `workspaceAccess: "none"` (по умолчанию) использует
  `~/.openclaw/sandboxes`
  - `"ro"` оставляет рабочее пространство sandbox в `/workspace` и
    монтирует рабочее пространство агента только для чтения в `/agent`
    (отключает `write`/`edit`/`apply_patch`)
  - `"rw"` монтирует рабочее пространство агента для чтения/записи в
    `/workspace`
- Автоочистка: простой > 24 ч ИЛИ возраст > 7 дн.
- Сеть: `none` по умолчанию (явно включайте, если нужен egress)
- Разрешено по умолчанию: `exec`, `process`, `read`,
  `write`, `edit`, `sessions_list`, `sessions_history`,
  `sessions_send`, `sessions_spawn`, `session_status`
- Запрещено по умолчанию: `browser`, `canvas`, `nodes`,
  `cron`, `discord`, `gateway`

### Включение sandboxing

Если вы планируете устанавливать пакеты в `setupCommand`, учтите:

- Значение `docker.network` по умолчанию — `"none"` (без egress).
- `readOnlyRoot: true` блокирует установку пакетов.
- `user` должен быть root для `apt-get` (уберите `user` или
  установите `user: "0:0"`).
  OpenClaw автоматически пересоздаёт контейнеры при изменении `setupCommand`
  (или конфигурации Docker), если контейнер не **использовался недавно**
  (в течение ~5 минут). «Горячие» контейнеры пишут предупреждение с точной командой
  `openclaw sandbox recreate ...`.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Параметры усиления защиты находятся в `agents.defaults.sandbox.docker`:
`network`, `user`, `pidsLimit`, `memory`,
`memorySwap`, `cpus`, `ulimits`, `seccompProfile`,
`apparmorProfile`, `dns`, `extraHosts`.

Multi-agent: переопределяйте `agents.defaults.sandbox.{docker,browser,prune}.*` для каждого агента через
`agents.list[].sandbox.{docker,browser,prune}.*` (игнорируется, когда `agents.defaults.sandbox.scope` / `agents.list[].sandbox.scope` равно
`"shared"`).

### Сборка образа sandbox по умолчанию

```bash
scripts/sandbox-setup.sh
```

Это собирает `openclaw-sandbox:bookworm-slim` с использованием `Dockerfile.sandbox`.

### Общий образ sandbox (необязательно)

Если вам нужен образ sandbox с распространёнными инструментами сборки (Node, Go,
Rust и т. д.), соберите общий образ:

```bash
scripts/sandbox-common-setup.sh
```

Это собирает `openclaw-sandbox-common:bookworm-slim`. Чтобы использовать его:

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "openclaw-sandbox-common:bookworm-slim" } },
    },
  },
}
```

### Образ браузера sandbox

Чтобы запускать инструмент браузера внутри sandbox, соберите образ браузера:

```bash
scripts/sandbox-browser-setup.sh
```

Это собирает `openclaw-sandbox-browser:bookworm-slim` с использованием
`Dockerfile.sandbox-browser`. Контейнер запускает Chromium с включённым CDP и
необязательным наблюдателем noVNC (headful через Xvfb).

Примечания:

- Headful (Xvfb) снижает блокировку ботами по сравнению с headless.
- Headless всё ещё можно использовать, установив `agents.defaults.sandbox.browser.headless=true`.
- Полноценная среда рабочего стола (GNOME) не требуется; Xvfb обеспечивает дисплей.

Используйте конфиг:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: { enabled: true },
      },
    },
  },
}
```

Пользовательский образ браузера:

```json5
{
  agents: {
    defaults: {
      sandbox: { browser: { image: "my-openclaw-browser" } },
    },
  },
}
```

При включении агент получает:

- URL управления браузером sandbox (для инструмента `browser`)
- URL noVNC (если включён и headless=false)

Помните: если вы используете список разрешённых инструментов, добавьте
`browser` (и удалите его из deny), иначе инструмент останется заблокированным.
Правила очистки (`agents.defaults.sandbox.prune`) применяются и к браузерным контейнерам.

### Пользовательский образ sandbox

Соберите собственный образ и укажите его в конфигурации:

```bash
docker build -t my-openclaw-sbx -f Dockerfile.sandbox .
```

```json5
{
  agents: {
    defaults: {
      sandbox: { docker: { image: "my-openclaw-sbx" } },
    },
  },
}
```

### Политика инструментов (allow/deny)

- `deny` имеет приоритет над `allow`.
- Если `allow` пуст: доступны все инструменты (кроме запрещённых).
- Если `allow` непуст: доступны только инструменты из `allow`
  (за вычетом deny).

### Стратегия очистки

Два параметра:

- `prune.idleHours`: удалять контейнеры, не использовавшиеся X часов (0 = отключить)
- `prune.maxAgeDays`: удалять контейнеры старше X дней (0 = отключить)

Пример:

- Сохранять активные сеансы, но ограничивать срок жизни:
  `idleHours: 24`, `maxAgeDays: 7`
- Никогда не очищать:
  `idleHours: 0`, `maxAgeDays: 0`

### Примечания по безопасности

- Жёсткая изоляция применяется только к **инструментам** (exec/read/write/edit/apply_patch).
- Инструменты, работающие только на хосте, такие как browser/camera/canvas, по
  умолчанию заблокированы.
- Разрешение `browser` в sandbox **ломает изоляцию** (браузер запускается на хосте).

## Устранение неполадок

- Образ отсутствует: соберите с помощью [`scripts/sandbox-setup.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/sandbox-setup.sh) или установите `agents.defaults.sandbox.docker.image`.
- Контейнер не запущен: он автоматически создаётся по требованию для каждого сеанса.
- Ошибки прав доступа в sandbox: установите `docker.user` в UID:GID, соответствующие
  владельцу смонтированного рабочего пространства (или выполните chown для папки
  рабочего пространства).
- Пользовательские инструменты не найдены: OpenClaw запускает команды с
  `sh -lc` (login shell), который источает `/etc/profile` и может сбрасывать
  PATH. Установите `docker.env.PATH`, чтобы добавить ваши пути к инструментам (например,
  `/custom/bin:/usr/local/share/npm-global/bin`), или добавьте скрипт в `/etc/profile.d/` в вашем Dockerfile.
