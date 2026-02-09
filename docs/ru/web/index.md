---
summary: "Веб‑поверхности Gateway: UI управления, режимы привязки и безопасность"
read_when:
  - Вам нужен доступ к Gateway через Tailscale
  - Вам нужен браузерный UI управления и редактирование конфига
title: "Web"
---

# Web (Gateway)

Gateway обслуживает небольшой **браузерный UI управления** (Vite + Lit) с того же порта, что и WebSocket Gateway:

- по умолчанию: `http://<host>:18789/`
- необязательный префикс: установите `gateway.controlUi.basePath` (например, `/openclaw`)

Возможности описаны в [Control UI](/web/control-ui).
На этой странице рассматриваются режимы привязки, безопасность и веб‑поверхности.

## Webhooks

Когда `hooks.enabled=true`, Gateway также публикует небольшой endpoint для вебхуков на том же HTTP‑сервере. См.
См. [Конфигурация шлюза] (/gateway/configuration) → `hooks` для аутентификации + payloads.

## Config (включено по умолчанию)

UI управления **включён по умолчанию**, когда ассеты присутствуют (`dist/control-ui`).
Управлять им можно через конфиг:

```json5
{
  gateway: {
    controlUi: { enabled: true, basePath: "/openclaw" }, // basePath optional
  },
}
```

## Доступ через Tailscale

### Integrated Serve (рекомендуется)

Оставьте Gateway на loopback и позвольте Tailscale Serve проксировать его:

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Затем запустите gateway:

```bash
openclaw gateway
```

Откройте:

- `https://<magicdns>/` (или настроенный вами `gateway.controlUi.basePath`)

### Привязка к tailnet + токен

```json5
{
  gateway: {
    bind: "tailnet",
    controlUi: { enabled: true },
    auth: { mode: "token", token: "your-token" },
  },
}
```

Затем запустите gateway (для привязок не к loopback требуется токен):

```bash
openclaw gateway
```

Откройте:

- `http://<tailscale-ip>:18789/` (или настроенный вами `gateway.controlUi.basePath`)

### Публичный интернет (Funnel)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password" }, // or OPENCLAW_GATEWAY_PASSWORD
  },
}
```

## Примечания по безопасности

- Аутентификация Gateway по умолчанию обязательна (токен/пароль или заголовки идентификации Tailscale).
- Привязки не к loopback по‑прежнему **требуют** общий токен/пароль (`gateway.auth` или через переменные окружения).
- Мастер настройки по умолчанию генерирует токен Gateway (даже на loopback).
- UI отправляет `connect.params.auth.token` или `connect.params.auth.password`.
- UI управления отправляет заголовки защиты от clickjacking и принимает только same‑origin
  WebSocket‑подключения браузера, если не задано `gateway.controlUi.allowedOrigins`.
- При использовании Serve заголовки идентификации Tailscale могут удовлетворять требованиям аутентификации, когда
  `gateway.auth.allowTailscale` — `true` (токен/пароль не требуются). Установите
  `gateway.auth.allowTailscale: false`, чтобы требовать явные учётные данные. См. [Tailscale](/gateway/tailscale) и [Безопасность](/gateway/security).
- `gateway.tailscale.mode: "funnel"` требует `gateway.auth.mode: "password"` (общий пароль).

## Сборка UI

Gateway обслуживает статические файлы из `dist/control-ui`. Соберите их командой:

```bash
pnpm ui:build # auto-installs UI deps on first run
```
