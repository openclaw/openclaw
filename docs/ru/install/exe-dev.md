---
summary: "Запуск OpenClaw Gateway на exe.dev (VM + HTTPS‑прокси) для удалённого доступа"
read_when:
  - Вам нужен недорогой постоянно работающий хост Linux для Gateway
  - Вам нужен удалённый доступ к Control UI без развёртывания собственного VPS
title: "exe.dev"
---

# exe.dev

Цель: OpenClaw Gateway, запущенный на VM exe.dev, доступный с вашего ноутбука через: `https://<vm-name>.exe.xyz`

На этой странице предполагается использование стандартного образа **exeuntu** от exe.dev. Если вы выбрали другой дистрибутив, сопоставьте пакеты соответствующим образом.

## Быстрый путь для начинающих

1. [https://exe.new/openclaw](https://exe.new/openclaw)
2. Заполните ключ/токен аутентификации при необходимости
3. Нажмите «Agent» рядом с вашей VM и подождите…
4. ???
5. Profit

## Что нужно

- учётная запись exe.dev
- `ssh exe.dev` доступ к виртуальным машинам [exe.dev](https://exe.dev) (необязательно)

## Автоматическая установка с Shelley

Shelley — агент [exe.dev](https://exe.dev) — может установить OpenClaw мгновенно с помощью нашего
промпта. Используемый промпт приведён ниже:

```
Set up OpenClaw (https://docs.openclaw.ai/install) on this VM. Use the non-interactive and accept-risk flags for openclaw onboarding. Add the supplied auth or token as needed. Configure nginx to forward from the default port 18789 to the root location on the default enabled site config, making sure to enable Websocket support. Pairing is done by "openclaw devices list" and "openclaw device approve <request id>". Make sure the dashboard shows that OpenClaw's health is OK. exe.dev handles forwarding from port 8000 to port 80/443 and HTTPS for us, so the final "reachable" should be <vm-name>.exe.xyz, without port specification.
```

## Ручная установка

## 1. Создание VM

С вашего устройства:

```bash
ssh exe.dev new
```

Затем подключитесь:

```bash
ssh <vm-name>.exe.xyz
```

Совет: держите эту VM **stateful**. OpenClaw хранит состояние в `~/.openclaw/` и `~/.openclaw/workspace/`.

## 2. Установка предварительных требований (на VM)

```bash
sudo apt-get update
sudo apt-get install -y git curl jq ca-certificates openssl
```

## 3. Установка OpenClaw

Запустите скрипт установки OpenClaw:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

## 4. Настройка nginx для проксирования OpenClaw на порт 8000

Отредактируйте `/etc/nginx/sites-enabled/default`, добавив

```
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    listen 8000;
    listen [::]:8000;

    server_name _;

    location / {
        proxy_pass http://127.0.0.1:18789;
        proxy_http_version 1.1;

        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeout settings for long-lived connections
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

## 5. Доступ к OpenClaw и выдача прав

Откройте `https://<vm-name>.exe.xyz/` (см. вывод Control UI при онбординге). Если будет запрошена аутентификация, вставьте
токен из `gateway.auth.token` на VM (получить с помощью `openclaw config get gateway.auth.token` или сгенерировать
через `openclaw doctor --generate-gateway-token`). Подтвердите устройства с помощью `openclaw devices list` и
`openclaw devices approve <requestId>`. Если сомневаетесь, используйте Shelley прямо из браузера!

## Удалённый доступ

Удалённый доступ обеспечивается аутентификацией [exe.dev](https://exe.dev). По
умолчанию HTTP‑трафик с порта 8000 перенаправляется на `https://<vm-name>.exe.xyz`
с аутентификацией по электронной почте.

## Обновление

```bash
npm i -g openclaw@latest
openclaw doctor
openclaw gateway restart
openclaw health
```

Руководство: [Обновление](/install/updating)
