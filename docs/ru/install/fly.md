---
title: Fly.io
description: Развёртывание OpenClaw на Fly.io
---

# Развёртывание на Fly.io

**Цель:** Gateway (шлюз) OpenClaw, запущенный на машине [Fly.io](https://fly.io) с постоянным хранилищем, автоматическим HTTPS и доступом к Discord/каналам.

## Что потребуется

- Установленный [CLI flyctl](https://fly.io/docs/hands-on/install-flyctl/)
- Учётная запись Fly.io (подходит бесплатный тариф)
- Аутентификация модели: ключ API Anthropic (или ключи других провайдеров)
- Учётные данные каналов: токен бота Discord, токен Telegram и т. д.

## Быстрый путь для начинающих

1. Клонировать репозиторий → настроить `fly.toml`
2. Создать приложение и том → задать секреты
3. Развернуть с помощью `fly deploy`
4. Подключиться по SSH для создания конфига или использовать Control UI

## 1) Создание приложения Fly

```bash
# Clone the repo
git clone https://github.com/openclaw/openclaw.git
cd openclaw

# Create a new Fly app (pick your own name)
fly apps create my-openclaw

# Create a persistent volume (1GB is usually enough)
fly volumes create openclaw_data --size 1 --region iad
```

**Совет:** Выберите регион, близкий к вам. Распространённые варианты: `lhr` (Лондон), `iad` (Вирджиния), `sjc` (Сан-Хосе).

## 2. Настройка fly.toml

Отредактируйте `fly.toml` в соответствии с именем вашего приложения и требованиями.

**Примечание по безопасности:** Конфигурация по умолчанию публикует общедоступный URL. Для защищённого развёртывания без публичного IP см. [Private Deployment](#private-deployment-hardened) или используйте `fly.private.toml`.

```toml
app = "my-openclaw"  # Your app name
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  OPENCLAW_PREFER_PNPM = "1"
  OPENCLAW_STATE_DIR = "/data"
  NODE_OPTIONS = "--max-old-space-size=1536"

[processes]
  app = "node dist/index.js gateway --allow-unconfigured --port 3000 --bind lan"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1
  processes = ["app"]

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048mb"

[mounts]
  source = "openclaw_data"
  destination = "/data"
```

**Ключевые параметры:**

| Параметр                       | Зачем                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `--bind lan`                   | Привязывается к `0.0.0.0`, чтобы прокси Fly мог обращаться к шлюзу                                      |
| `--allow-unconfigured`         | Запуск без файла конфига (вы создадите его позже)                                    |
| `internal_port = 3000`         | Должен совпадать с `--port 3000` (или `OPENCLAW_GATEWAY_PORT`) для health checks Fly |
| `memory = "2048mb"`            | 512 МБ слишком мало; рекомендуется 2 ГБ                                                                 |
| `OPENCLAW_STATE_DIR = "/data"` | Сохраняет состояние на громкости                                                                        |

## 3. Установка секретов

```bash
# Required: Gateway token (for non-loopback binding)
fly secrets set OPENCLAW_GATEWAY_TOKEN=$(openssl rand -hex 32)

# Model provider API keys
fly secrets set ANTHROPIC_API_KEY=sk-ant-...

# Optional: Other providers
fly secrets set OPENAI_API_KEY=sk-...
fly secrets set GOOGLE_API_KEY=...

# Channel tokens
fly secrets set DISCORD_BOT_TOKEN=MTQ...
```

**Примечания:**

- Привязки не к loopback (`--bind lan`) требуют `OPENCLAW_GATEWAY_TOKEN` из соображений безопасности.
- Обращайтесь с этими токенами как с паролями.
- **Предпочитайте переменные окружения файлу конфига** для всех ключей API и токенов. Это предотвращает попадание секретов в `openclaw.json`, где они могут быть случайно раскрыты или залогированы.

## 4. Развёртывание

```bash
fly deploy
```

Первое развёртывание собирает Docker-образ (~2–3 минуты). Последующие развёртывания выполняются быстрее.

После развёртывания проверьте:

```bash
fly status
fly logs
```

Вы должны увидеть:

```
[gateway] listening on ws://0.0.0.0:3000 (PID xxx)
[discord] logged in to discord as xxx
```

## 5. Создание файла конфига

Подключитесь по SSH к машине, чтобы создать корректный конфиг:

```bash
fly ssh console
```

Создайте каталог и файл конфига:

```bash
mkdir -p /data
cat > /data/openclaw.json << 'EOF'
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]
      },
      "maxConcurrent": 4
    },
    "list": [
      {
        "id": "main",
        "default": true
      }
    ]
  },
  "auth": {
    "profiles": {
      "anthropic:default": { "mode": "token", "provider": "anthropic" },
      "openai:default": { "mode": "token", "provider": "openai" }
    }
  },
  "bindings": [
    {
      "agentId": "main",
      "match": { "channel": "discord" }
    }
  ],
  "channels": {
    "discord": {
      "enabled": true,
      "groupPolicy": "allowlist",
      "guilds": {
        "YOUR_GUILD_ID": {
          "channels": { "general": { "allow": true } },
          "requireMention": false
        }
      }
    }
  },
  "gateway": {
    "mode": "local",
    "bind": "auto"
  },
  "meta": {
    "lastTouchedVersion": "2026.1.29"
  }
}
EOF
```

**Примечание:** При использовании `OPENCLAW_STATE_DIR=/data` путь к конфигу — `/data/openclaw.json`.

**Примечание:** Токен Discord может задаваться одним из способов:

- Переменная окружения: `DISCORD_BOT_TOKEN` (рекомендуется для секретов)
- Файл конфига: `channels.discord.token`

Если используется переменная окружения, добавлять токен в конфиг не нужно. Шлюз автоматически читает `DISCORD_BOT_TOKEN`.

Перезапустите для применения:

```bash
exit
fly machine restart <machine-id>
```

## 6. Доступ к Gateway (шлюзу)

### Control UI

Откройте в браузере:

```bash
fly open
```

Или перейдите по адресу `https://my-openclaw.fly.dev/`

Вставьте ваш токен шлюза (тот, что из `OPENCLAW_GATEWAY_TOKEN`) для аутентификации.

### Логи

```bash
fly logs              # Live logs
fly logs --no-tail    # Recent logs
```

### Консоль SSH

```bash
fly ssh console
```

## Устранение неполадок

### «App is not listening on expected address»

Шлюз привязывается к `127.0.0.1` вместо `0.0.0.0`.

**Исправление:** Добавьте `--bind lan` в команду процесса в `fly.toml`.

### Сбои health checks / connection refused

Fly не может подключиться к шлюзу на настроенном порту.

**Исправление:** Убедитесь, что `internal_port` соответствует порту шлюза (задайте `--port 3000` или `OPENCLAW_GATEWAY_PORT=3000`).

### OOM / проблемы с памятью

Контейнер постоянно перезапускается или завершается. Признаки: `SIGABRT`, `v8::internal::Runtime_AllocateInYoungGeneration` или «тихие» перезапуски.

**Исправление:** Увеличьте память в `fly.toml`:

```toml
[[vm]]
  memory = "2048mb"
```

Или обновите существующую машину:

```bash
fly machine update <machine-id> --vm-memory 2048 -y
```

**Примечание:** 512 МБ — слишком мало. 1 ГБ может работать, но возможен OOM под нагрузкой или при подробном логировании. **Рекомендуется 2 ГБ.**

### Проблемы с блокировкой Gateway

Шлюз отказывается запускаться с ошибками «already running».

Это происходит, когда контейнер перезапускается, но PID-файл блокировки сохраняется на томе.

**Исправление:** Удалите файл блокировки:

```bash
fly ssh console --command "rm -f /data/gateway.*.lock"
fly machine restart <machine-id>
```

Файл блокировки находится по пути `/data/gateway.*.lock` (не в подкаталоге).

### Конфиг не читается

При использовании `--allow-unconfigured` шлюз создаёт минимальный конфиг. Ваш пользовательский конфиг по пути `/data/openclaw.json` должен читаться после перезапуска.

Проверьте, что конфиг существует:

```bash
fly ssh console --command "cat /data/openclaw.json"
```

### Запись конфига через SSH

Команда `fly ssh console -C` не поддерживает перенаправление оболочки. Чтобы записать файл конфига:

```bash
# Use echo + tee (pipe from local to remote)
echo '{"your":"config"}' | fly ssh console -C "tee /data/openclaw.json"

# Or use sftp
fly sftp shell
> put /local/path/config.json /data/openclaw.json
```

**Примечание:** `fly sftp` может завершиться с ошибкой, если файл уже существует. Сначала удалите его:

```bash
fly ssh console --command "rm /data/openclaw.json"
```

### Состояние не сохраняется

Если после перезапуска теряются учётные данные или сессии, каталог состояния записывается в файловую систему контейнера.

**Исправление:** Убедитесь, что `OPENCLAW_STATE_DIR=/data` задан в `fly.toml`, и выполните повторное развёртывание.

## Обновления

```bash
# Pull latest changes
git pull

# Redeploy
fly deploy

# Check health
fly status
fly logs
```

### Обновление команды машины

Если нужно изменить команду запуска без полного развёртывания:

```bash
# Get machine ID
fly machines list

# Update command
fly machine update <machine-id> --command "node dist/index.js gateway --port 3000 --bind lan" -y

# Or with memory increase
fly machine update <machine-id> --vm-memory 2048 --command "node dist/index.js gateway --port 3000 --bind lan" -y
```

**Примечание:** После `fly deploy` команда машины может быть сброшена к значению из `fly.toml`. Если вы вносили изменения вручную, примените их повторно после развёртывания.

## Частное развёртывание (усиленная защита)

По умолчанию Fly выделяет публичные IP-адреса, делая ваш шлюз доступным по адресу `https://your-app.fly.dev`. Это удобно, но означает, что развёртывание обнаружимо интернет-сканерами (Shodan, Censys и т. д.).

Для усиленного развёртывания **без публичного доступа** используйте частный шаблон.

### Когда использовать частное развёртывание

- Вы выполняете только **исходящие** вызовы/сообщения (без входящих вебхуков)
- Для любых колбэков вебхуков используете туннели **ngrok или Tailscale**
- Доступ к шлюзу осуществляется через **SSH, прокси или WireGuard**, а не через браузер
- Вы хотите, чтобы развёртывание было **скрыто от интернет-сканеров**

### Настройка

Используйте `fly.private.toml` вместо стандартной конфигурации:

```bash
# Deploy with private config
fly deploy -c fly.private.toml
```

Или преобразуйте существующее развёртывание:

```bash
# List current IPs
fly ips list -a my-openclaw

# Release public IPs
fly ips release <public-ipv4> -a my-openclaw
fly ips release <public-ipv6> -a my-openclaw

# Switch to private config so future deploys don't re-allocate public IPs
# (remove [http_service] or deploy with the private template)
fly deploy -c fly.private.toml

# Allocate private-only IPv6
fly ips allocate-v6 --private -a my-openclaw
```

После этого `fly ips list` должен показывать только IP типа `private`:

```
VERSION  IP                   TYPE             REGION
v6       fdaa:x:x:x:x::x      private          global
```

### Доступ к частному развёртыванию

Поскольку публичного URL нет, используйте один из способов:

**Вариант 1: Локальный прокси (самый простой)**

```bash
# Forward local port 3000 to the app
fly proxy 3000:3000 -a my-openclaw

# Then open http://localhost:3000 in browser
```

**Вариант 2: VPN WireGuard**

```bash
# Create WireGuard config (one-time)
fly wireguard create

# Import to WireGuard client, then access via internal IPv6
# Example: http://[fdaa:x:x:x:x::x]:3000
```

**Вариант 3: Только SSH**

```bash
fly ssh console -a my-openclaw
```

### Вебхуки при частном развёртывании

Если требуются колбэки вебхуков (Twilio, Telnyx и т. д.) без публичного доступа:

1. **Туннель ngrok** — запустите ngrok внутри контейнера или как сайдкар
2. **Tailscale Funnel** — откройте конкретные пути через Tailscale
3. **Только исходящие** — некоторые провайдеры (Twilio) нормально работают для исходящих вызовов без вебхуков

Пример конфига голосового вызова с ngrok:

```json
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "config": {
          "provider": "twilio",
          "tunnel": { "provider": "ngrok" },
          "webhookSecurity": {
            "allowedHosts": ["example.ngrok.app"]
          }
        }
      }
    }
  }
}
```

Туннель ngrok работает внутри контейнера и предоставляет публичный URL вебхука, не раскрывая само приложение Fly. Установите `webhookSecurity.allowedHosts` в имя хоста публичного туннеля, чтобы принимались проброшенные заголовки host.

### Преимущества безопасности

| Аспект              | Публичное  | Частное       |
| ------------------- | ---------- | ------------- |
| Интернет-сканеры    | Обнаружимо | Скрыто        |
| Прямые атаки        | Возможны   | Заблокированы |
| Доступ к Control UI | Браузер    | Прокси/VPN    |
| Доставка вебхуков   | Напрямую   | Через туннель |

## Примечания

- Fly.io использует **архитектуру x86** (не ARM)
- Dockerfile совместим с обеими архитектурами
- Для онбординга WhatsApp/Telegram используйте `fly ssh console`
- Постоянные данные хранятся на томе по пути `/data`
- Signal требует Java + signal-cli; используйте пользовательский образ и держите память на уровне 2 ГБ+.

## Стоимость

С рекомендуемой конфигурацией (`shared-cpu-2x`, 2 ГБ ОЗУ):

- ~$10–15 в месяц в зависимости от использования
- Бесплатный тариф включает некоторый лимит

Подробности см. в [ценах Fly.io](https://fly.io/docs/about/pricing/).
