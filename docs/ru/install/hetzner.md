---
summary: "Запуск OpenClaw Gateway 24/7 на недорогом VPS Hetzner (Docker) с устойчивым состоянием и встроенными бинарниками"
read_when:
  - Вам нужен OpenClaw, работающий 24/7 на облачном VPS (не на вашем ноутбуке)
  - Вам нужен производственный, всегда включённый Gateway на собственном VPS
  - Вам нужен полный контроль над постоянным хранилищем, бинарниками и поведением перезапуска
  - Вы запускаете OpenClaw в Docker на Hetzner или у аналогичного провайдера
title: "Hetzner"
---

# OpenClaw на Hetzner (Docker, руководство для production VPS)

## Цель

Запустить постоянный OpenClaw Gateway на VPS Hetzner с использованием Docker, с устойчивым состоянием, встроенными бинарниками и безопасным поведением при перезапуске.

Если вам нужен «OpenClaw 24/7 примерно за ~$5», это самая простая надёжная настройка.
Цены Hetzner меняются; выберите самый маленький VPS с Debian/Ubuntu и масштабируйтесь, если столкнётесь с OOM.

## Что мы делаем (простыми словами)?

- Арендуем небольшой Linux-сервер (VPS Hetzner)
- Устанавливаем Docker (изолированная среда выполнения приложений)
- Запускаем OpenClaw Gateway в Docker
- Сохраняем `~/.openclaw` + `~/.openclaw/workspace` на хосте (переживает перезапуски/пересборки)
- Получаем доступ к Control UI с ноутбука через SSH-туннель

Доступ к Gateway возможен через:

- Проброс портов SSH с вашего ноутбука
- Прямое открытие порта, если вы самостоятельно управляете файрволом и токенами

Это руководство предполагает Ubuntu или Debian на Hetzner.  
Если у вас другой Linux VPS, сопоставьте пакеты соответствующим образом.
Для общего Docker-потока см. [Docker](/install/docker).

---

## Быстрый путь (для опытных операторов)

1. Подготовить VPS Hetzner
2. Установить Docker
3. Клонировать репозиторий OpenClaw
4. Создать постоянные каталоги на хосте
5. Настроить `.env` и `docker-compose.yml`
6. Встроить необходимые бинарники в образ
7. `docker compose up -d`
8. Проверить сохранность данных и доступ к Gateway

---

## Что вам понадобится

- VPS Hetzner с root-доступом
- SSH-доступ с вашего ноутбука
- Базовое владение SSH + копированием/вставкой
- ~20 минут
- Docker и Docker Compose
- Учётные данные аутентификации модели
- Необязательные учетные данные поставщика
  - QR для WhatsApp
  - Токен бота Telegram
  - OAuth Gmail

---

## 1. Подготовка VPS

Создайте VPS с Ubuntu или Debian в Hetzner.

Подключитесь как root:

```bash
ssh root@YOUR_VPS_IP
```

Это руководство предполагает, что VPS является состоянием.
Не рассматривайте его как одноразовую инфраструктуру.

---

## 2. Установка Docker (на VPS)

```bash
apt-get update
apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sh
```

Проверьте:

```bash
docker --version
docker compose version
```

---

## 3. Клонирование репозитория OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

Это руководство предполагает, что вы будете собирать кастомный образ для гарантии сохранности бинарников.

---

## 4. Создание постоянных каталогов на хосте

Docker-контейнеры эфемерны.
Все долгоживущее состояние должно храниться на хосте.

```bash
mkdir -p /root/.openclaw
mkdir -p /root/.openclaw/workspace

# Set ownership to the container user (uid 1000):
chown -R 1000:1000 /root/.openclaw
chown -R 1000:1000 /root/.openclaw/workspace
```

---

## 5. Настройка переменных окружения

Создайте `.env` в корне репозитория.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/root/.openclaw
OPENCLAW_WORKSPACE_DIR=/root/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Сгенерируйте надёжные секреты:

```bash
openssl rand -hex 32
```

**Не коммитьте этот файл.**

---

## 6. Конфигурация Docker Compose

Создайте или обновите `docker-compose.yml`.

```yaml
services:
  openclaw-gateway:
    image: ${OPENCLAW_IMAGE}
    build: .
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - HOME=/home/node
      - NODE_ENV=production
      - TERM=xterm-256color
      - OPENCLAW_GATEWAY_BIND=${OPENCLAW_GATEWAY_BIND}
      - OPENCLAW_GATEWAY_PORT=${OPENCLAW_GATEWAY_PORT}
      - OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}
      - GOG_KEYRING_PASSWORD=${GOG_KEYRING_PASSWORD}
      - XDG_CONFIG_HOME=${XDG_CONFIG_HOME}
      - PATH=/home/linuxbrew/.linuxbrew/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    volumes:
      - ${OPENCLAW_CONFIG_DIR}:/home/node/.openclaw
      - ${OPENCLAW_WORKSPACE_DIR}:/home/node/.openclaw/workspace
    ports:
      # Recommended: keep the Gateway loopback-only on the VPS; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VPS and need Canvas host.
      # If you expose this publicly, read /gateway/security and firewall accordingly.
      # - "18793:18793"
    command:
      [
        "node",
        "dist/index.js",
        "gateway",
        "--bind",
        "${OPENCLAW_GATEWAY_BIND}",
        "--port",
        "${OPENCLAW_GATEWAY_PORT}",
      ]
```

---

## 7. Встраивание необходимых бинарников в образ (критично)

Установка бинарников внутри запущенного контейнера — ловушка.
Всё, что установлено во время выполнения, будет потеряно при перезапуске.

Все внешние бинарники, необходимые Skills, должны устанавливаться на этапе сборки образа.

Примеры ниже показывают только три распространённых бинарника:

- `gog` для доступа к Gmail
- `goplaces` для Google Places
- `wacli` для WhatsApp

Это примеры, а не полный список.
Вы можете устанавливать столько бинарников, сколько нужно, используя тот же шаблон.

Если позже вы добавите новые Skills, зависящие от дополнительных бинарников, необходимо:

1. Обновить Dockerfile
2. Пересобрать образ
3. Перезапустить контейнеры

**Пример Dockerfile**

```dockerfile
FROM node:22-bookworm

RUN apt-get update && apt-get install -y socat && rm -rf /var/lib/apt/lists/*

# Example binary 1: Gmail CLI
RUN curl -L https://github.com/steipete/gog/releases/latest/download/gog_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/gog

# Example binary 2: Google Places CLI
RUN curl -L https://github.com/steipete/goplaces/releases/latest/download/goplaces_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/goplaces

# Example binary 3: WhatsApp CLI
RUN curl -L https://github.com/steipete/wacli/releases/latest/download/wacli_Linux_x86_64.tar.gz \
  | tar -xz -C /usr/local/bin && chmod +x /usr/local/bin/wacli

# Add more binaries below using the same pattern

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY ui/package.json ./ui/package.json
COPY scripts ./scripts

RUN corepack enable
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build
RUN pnpm ui:install
RUN pnpm ui:build

ENV NODE_ENV=production

CMD ["node","dist/index.js"]
```

---

## 8. Сборка и запуск

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Проверьте бинарники:

```bash
docker compose exec openclaw-gateway which gog
docker compose exec openclaw-gateway which goplaces
docker compose exec openclaw-gateway which wacli
```

Ожидаемый вывод:

```
/usr/local/bin/gog
/usr/local/bin/goplaces
/usr/local/bin/wacli
```

---

## 9. Проверка Gateway

```bash
docker compose logs -f openclaw-gateway
```

Успех:

```
[gateway] listening on ws://0.0.0.0:18789
```

С вашего ноутбука:

```bash
ssh -N -L 18789:127.0.0.1:18789 root@YOUR_VPS_IP
```

Откройте:

`http://127.0.0.1:18789/`

Вставьте токен вашего Gateway.

---

## Что и где сохраняется (источник истины)

OpenClaw работает в Docker, но Docker не является источником истины.
Всё долгоживущее состояние должно переживать перезапуски, пересборки и перезагрузки.

| Компонент                      | Расположение                      | Механизм сохранности    | Примечания                           |
| ------------------------------ | --------------------------------- | ----------------------- | ------------------------------------ |
| Конфигурация Gateway           | `/home/node/.openclaw/`           | Монтирование тома хоста | Включает `openclaw.json`, токены     |
| Профили аутентификации моделей | `/home/node/.openclaw/`           | Монтирование тома хоста | OAuth-токены, ключи API              |
| Конфиги Skills                 | `/home/node/.openclaw/skills/`    | Монтирование тома хоста | Состояние на уровне Skills           |
| Рабочее пространство агента    | `/home/node/.openclaw/workspace/` | Монтирование тома хоста | Код и артефакты агента               |
| Сеанс WhatsApp                 | `/home/node/.openclaw/`           | Монтирование тома хоста | Сохраняет вход по QR                 |
| Хранилище ключей Gmail         | `/home/node/.openclaw/`           | Том хоста + пароль      | Требуется `GOG_KEYRING_PASSWORD`     |
| Внешние бинарники              | `/usr/local/bin/`                 | Docker-образ            | Должен быть испечен во время сборки  |
| Среда выполнения Node          | Файловая система контейнера       | Docker-образ            | Восстановить все изображения         |
| Пакеты ОС                      | Файловая система контейнера       | Docker-образ            | Не устанавливать во время выполнения |
| Docker-контейнер               | Эфемерный                         | Перезапускаемый         | Безопасно удалять                    |
