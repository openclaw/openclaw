---
summary: "Запуск OpenClaw Gateway 24/7 на VM Google Compute Engine (Docker) с устойчивым состоянием"
read_when:
  - Вы хотите, чтобы OpenClaw работал 24/7 на GCP
  - Вам нужен production-уровня, всегда включённый Gateway (шлюз) на собственной VM
  - Вам нужен полный контроль над персистентностью, бинарными файлами и поведением перезапуска
title: "GCP"
---

# OpenClaw на GCP Compute Engine (Docker, руководство для production VPS)

## Цель

Запустить постоянный OpenClaw Gateway (шлюз) на VM Google Compute Engine с использованием Docker, с устойчивым состоянием, заранее встроенными бинарными файлами и безопасным поведением при перезапуске.

Если вам нужен «OpenClaw 24/7 за ~$5–12 в месяц», это надёжная конфигурация в Google Cloud.
Стоимость зависит от типа машины и региона; выбирайте минимальную VM, подходящую под вашу нагрузку, и масштабируйтесь при появлении OOM.

## Что мы делаем (простыми словами)?

- Создаём проект GCP и включаем биллинг
- Создаём VM Compute Engine
- Устанавливаем Docker (изолированная среда выполнения приложения)
- Запускаем OpenClaw Gateway (шлюз) в Docker
- Сохраняем `~/.openclaw` + `~/.openclaw/workspace` на хосте (переживает перезапуски и пересборки)
- Получаем доступ к Control UI с ноутбука через SSH-туннель

Доступ к Gateway (шлюзу) возможен через:

- SSH-проброс портов с вашего ноутбука
- Прямое открытие порта, если вы самостоятельно управляете firewall и токенами

В этом руководстве используется Debian на GCP Compute Engine.
Ubuntu также подходит; сопоставьте пакеты соответствующим образом.
Для общего Docker-потока см. [Docker](/install/docker).

---

## Быстрый путь (для опытных операторов)

1. Создать проект GCP и включить API Compute Engine
2. Создать VM Compute Engine (e2-small, Debian 12, 20GB)
3. Подключиться к VM по SSH
4. Установить Docker
5. Клонировать репозиторий OpenClaw
6. Создать постоянные директории на хосте
7. Настроить `.env` и `docker-compose.yml`
8. Встроить необходимые бинарные файлы, собрать образ и запустить

---

## Что вам понадобится

- Аккаунт GCP (free tier доступен для e2-micro)
- Установленный gcloud CLI (или использование Cloud Console)
- SSH-доступ с вашего ноутбука
- Базовые навыки работы с SSH и copy/paste
- ~20–30 минут
- Docker и Docker Compose
- Учётные данные для аутентификации модели
- Необязательные учетные данные поставщика
  - QR-код WhatsApp
  - Токен бота Telegram
  - OAuth Gmail

---

## 1. Установка gcloud CLI (или использование Console)

**Вариант A: gcloud CLI** (рекомендуется для автоматизации)

Установите по инструкции: [https://cloud.google.com/sdk/docs/install](https://cloud.google.com/sdk/docs/install)

Инициализируйте и выполните аутентификацию:

```bash
gcloud init
gcloud auth login
```

**Вариант B: Cloud Console**

Все шаги можно выполнить через веб-интерфейс: [https://console.cloud.google.com](https://console.cloud.google.com)

---

## 2. Создание проекта GCP

**CLI:**

```bash
gcloud projects create my-openclaw-project --name="OpenClaw Gateway"
gcloud config set project my-openclaw-project
```

Включите биллинг на странице [https://console.cloud.google.com/billing](https://console.cloud.google.com/billing) (обязательно для Compute Engine).

Включите API Compute Engine:

```bash
gcloud services enable compute.googleapis.com
```

**Console:**

1. Перейдите в IAM & Admin > Create Project
2. Задайте имя и создайте проект
3. Включите биллинг для проекта
4. Перейдите в APIs & Services > Enable APIs > найдите «Compute Engine API» > Enable

---

## 3. Создание VM

**Типы машин:**

| Тип      | Характеристики                              | Стоимость                | Примечания    |
| -------- | ------------------------------------------- | ------------------------ | ------------- |
| e2-small | 2 vCPU, 2GB RAM                             | ~$12/мес | Рекомендуется |
| e2-micro | 2 vCPU (shared), 1GB RAM | Доступно free tier       | Возможны OOM  |

**CLI:**

```bash
gcloud compute instances create openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small \
  --boot-disk-size=20GB \
  --image-family=debian-12 \
  --image-project=debian-cloud
```

**Console:**

1. Перейдите в Compute Engine > VM instances > Create instance
2. Имя: `openclaw-gateway`
3. Регион: `us-central1`, зона: `us-central1-a`
4. Тип машины: `e2-small`
5. Загрузочный диск: Debian 12, 20GB
6. Создать

---

## 4. Подключение к VM по SSH

**CLI:**

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

**Console:**

Нажмите кнопку «SSH» рядом с вашей VM в панели Compute Engine.

Примечание: распространение SSH-ключей может занять 1–2 минуты после создания VM. Если соединение отклонено, подождите и повторите попытку.

---

## 5. Установка Docker (на VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
```

Выйдите из системы и войдите снова, чтобы изменения групп вступили в силу:

```bash
exit
```

Затем снова подключитесь по SSH:

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a
```

Проверьте:

```bash
docker --version
docker compose version
```

---

## 6. Клонирование репозитория OpenClaw

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
```

В этом руководстве предполагается, что вы будете собирать собственный образ для гарантированной персистентности бинарных файлов.

---

## 7. Создание постоянных директорий на хосте

Docker-контейнеры являются эфемерными.
Все долгоживущие данные должны храниться на хосте.

```bash
mkdir -p ~/.openclaw
mkdir -p ~/.openclaw/workspace
```

---

## 8. Настройка переменных окружения

Создайте `.env` в корне репозитория.

```bash
OPENCLAW_IMAGE=openclaw:latest
OPENCLAW_GATEWAY_TOKEN=change-me-now
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_PORT=18789

OPENCLAW_CONFIG_DIR=/home/$USER/.openclaw
OPENCLAW_WORKSPACE_DIR=/home/$USER/.openclaw/workspace

GOG_KEYRING_PASSWORD=change-me-now
XDG_CONFIG_HOME=/home/node/.openclaw
```

Сгенерируйте надёжные секреты:

```bash
openssl rand -hex 32
```

**Не коммитьте этот файл.**

---

## 9. Конфигурация Docker Compose

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
      # Recommended: keep the Gateway loopback-only on the VM; access via SSH tunnel.
      # To expose it publicly, remove the `127.0.0.1:` prefix and firewall accordingly.
      - "127.0.0.1:${OPENCLAW_GATEWAY_PORT}:18789"

      # Optional: only if you run iOS/Android nodes against this VM and need Canvas host.
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

## 10. Встраивание необходимых бинарных файлов в образ (критично)

Установка бинарных файлов внутри работающего контейнера — ловушка.
Всё, что установлено во время выполнения, будет потеряно при перезапуске.

Все внешние бинарные файлы, необходимые Skills, должны устанавливаться на этапе сборки образа.

В примерах ниже показаны только три распространённых бинарных файла:

- `gog` для доступа к Gmail
- `goplaces` для Google Places
- `wacli` для WhatsApp

Это лишь примеры, а не полный список.
Вы можете устанавливать любое количество бинарных файлов, используя тот же шаблон.

Если позже вы добавите новые Skills, зависящие от дополнительных бинарных файлов, необходимо:

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

## 11. Сборка и запуск

```bash
docker compose build
docker compose up -d openclaw-gateway
```

Проверьте бинарные файлы:

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

## 12. Проверка Gateway (шлюза)

```bash
docker compose logs -f openclaw-gateway
```

Успех:

```
[gateway] listening on ws://0.0.0.0:18789
```

---

## 13. Доступ с вашего ноутбука

Создайте SSH-туннель для проброса порта Gateway (шлюза):

```bash
gcloud compute ssh openclaw-gateway --zone=us-central1-a -- -L 18789:127.0.0.1:18789
```

Откройте в браузере:

`http://127.0.0.1:18789/`

Вставьте ваш токен Gateway.

---

## Что где сохраняется (источник истины)

OpenClaw работает в Docker, но Docker не является источником истины.
Все долгоживущие данные должны переживать перезапуски, пересборки и перезагрузки.

| Компонент                      | Расположение                      | Механизм персистентности | Примечания                           |
| ------------------------------ | --------------------------------- | ------------------------ | ------------------------------------ |
| Конфигурация Gateway           | `/home/node/.openclaw/`           | Монтирование тома хоста  | Включает `openclaw.json`, токены     |
| Профили аутентификации моделей | `/home/node/.openclaw/`           | Монтирование тома хоста  | OAuth-токены, ключи API              |
| Конфиги Skills                 | `/home/node/.openclaw/skills/`    | Монтирование тома хоста  | Состояние на уровне Skills           |
| Рабочее пространство агента    | `/home/node/.openclaw/workspace/` | Монтирование тома хоста  | Код и артефакты агента               |
| Сеанс WhatsApp                 | `/home/node/.openclaw/`           | Монтирование тома хоста  | Сохраняет вход по QR                 |
| Связка ключей Gmail            | `/home/node/.openclaw/`           | Том хоста + пароль       | Требуется `GOG_KEYRING_PASSWORD`     |
| Внешние бинарные файлы         | `/usr/local/bin/`                 | Docker-образ             | Должен быть испечен во время сборки  |
| Среда выполнения Node          | Файловая система контейнера       | Docker-образ             | Восстановить все изображения         |
| Пакеты ОС                      | Файловая система контейнера       | Docker-образ             | Не устанавливать во время выполнения |
| Docker-контейнер               | Эфемерный                         | Перезапускаемый          | Безопасно удалять                    |

---

## Обновления

Чтобы обновить OpenClaw на VM:

```bash
cd ~/openclaw
git pull
docker compose build
docker compose up -d
```

---

## Устранение неполадок

**SSH connection refused**

Распространение SSH-ключей может занять 1–2 минуты после создания VM. Подождите и повторите попытку.

**Проблемы OS Login**

Проверьте профиль OS Login:

```bash
gcloud compute os-login describe-profile
```

Убедитесь, что у вашей учётной записи есть необходимые IAM-права (Compute OS Login или Compute OS Admin Login).

**Out of memory (OOM)**

Если при использовании e2-micro возникает OOM, обновитесь до e2-small или e2-medium:

```bash
# Stop the VM first
gcloud compute instances stop openclaw-gateway --zone=us-central1-a

# Change machine type
gcloud compute instances set-machine-type openclaw-gateway \
  --zone=us-central1-a \
  --machine-type=e2-small

# Start the VM
gcloud compute instances start openclaw-gateway --zone=us-central1-a
```

---

## Service accounts (лучшая практика безопасности)

Для личного использования достаточно вашей учётной записи по умолчанию.

Для автоматизации или CI/CD-пайплайнов создайте отдельную service account с минимальными правами:

1. Создайте service account:

   ```bash
   gcloud iam service-accounts create openclaw-deploy \
     --display-name="OpenClaw Deployment"
   ```

2. Назначьте роль Compute Instance Admin (или более узкую кастомную роль):

   ```bash
   gcloud projects add-iam-policy-binding my-openclaw-project \
     --member="serviceAccount:openclaw-deploy@my-openclaw-project.iam.gserviceaccount.com" \
     --role="roles/compute.instanceAdmin.v1"
   ```

Избегайте использования роли Owner для автоматизации. Следуйте принципу наименьших привилегий.

Подробности о ролях IAM см. на странице [https://cloud.google.com/iam/docs/understanding-roles](https://cloud.google.com/iam/docs/understanding-roles).

---

## Дальнейшие шаги

- Настройте каналы обмена сообщениями: [Channels](/channels)
- Подключите локальные устройства как узлы: [Nodes](/nodes)
- Настройте Gateway (шлюз): [Gateway configuration](/gateway/configuration)
