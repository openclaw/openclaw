---
summary: "Интегрированный Tailscale Serve/Funnel для панели Gateway (шлюз)"
read_when:
  - Публикация панели управления Gateway (шлюз) вне localhost
  - Автоматизация доступа к tailnet или публичной панели
title: "Tailscale"
---

# Tailscale (панель Gateway (шлюз))

OpenClaw может автоматически настраивать Tailscale **Serve** (tailnet) или **Funnel** (публичный доступ) для
панели Gateway (шлюз) и порта WebSocket. Это позволяет держать Gateway привязанным к loopback, в то время как
Tailscale предоставляет HTTPS, маршрутизацию и (для Serve) заголовки идентификации.

## Режимы

- `serve`: Только tailnet Serve через `tailscale serve`. Gateway остаётся на `127.0.0.1`.
- `funnel`: Публичный HTTPS через `tailscale funnel`. OpenClaw требует общий пароль.
- `off`: По умолчанию (без автоматизации Tailscale).

## Аутентификация

Установите `gateway.auth.mode` для управления рукопожатием:

- `token` (по умолчанию, когда установлен `OPENCLAW_GATEWAY_TOKEN`)
- `password` (общий секрет через `OPENCLAW_GATEWAY_PASSWORD` или конфиг)

Когда `tailscale.mode = "serve"` и `gateway.auth.allowTailscale` равно `true`,
корректные прокси‑запросы Serve могут аутентифицироваться через заголовки идентификации Tailscale
(`tailscale-user-login`) без передачи токена/пароля. OpenClaw проверяет
идентичность, разрешая адрес `x-forwarded-for` через локальный демон Tailscale
(`tailscale whois`) и сопоставляя его с заголовком перед принятием запроса.
OpenClaw рассматривает запрос как Serve только если он приходит с loopback с
заголовками Tailscale `x-forwarded-for`, `x-forwarded-proto` и `x-forwarded-host`.
Чтобы требовать явные учётные данные, установите `gateway.auth.allowTailscale: false` или
принудительно включите `gateway.auth.mode: "password"`.

## Примеры конфигурации

### Только tailnet (Serve)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "serve" },
  },
}
```

Открыть: `https://<magicdns>/` (или ваш настроенный `gateway.controlUi.basePath`)

### Только tailnet (привязка к IP Tailnet)

Используйте это, если хотите, чтобы Gateway слушал напрямую на IP Tailnet (без Serve/Funnel).

```json5
{
  gateway: {
    bind: "tailnet",
    auth: { mode: "token", token: "your-token" },
  },
}
```

Подключение с другого устройства в tailnet:

- Панель управления: `http://<tailscale-ip>:18789/`
- WebSocket: `ws://<tailscale-ip>:18789`

Примечание: loopback (`http://127.0.0.1:18789`) **не** будет работать в этом режиме.

### Публичный интернет (Funnel + общий пароль)

```json5
{
  gateway: {
    bind: "loopback",
    tailscale: { mode: "funnel" },
    auth: { mode: "password", password: "replace-me" },
  },
}
```

Предпочтительно использовать `OPENCLAW_GATEWAY_PASSWORD` вместо сохранения пароля на диск.

## Примеры CLI

```bash
openclaw gateway --tailscale serve
openclaw gateway --tailscale funnel --auth password
```

## Примечания

- Tailscale Serve/Funnel требует установленный и авторизованный CLI `tailscale`.
- `tailscale.mode: "funnel"` отказывается запускаться, если режим аутентификации не `password`, чтобы избежать публичного доступа.
- Установите `gateway.tailscale.resetOnExit`, если хотите, чтобы OpenClaw отменял конфигурацию `tailscale serve`
  или `tailscale funnel` при завершении работы.
- `gateway.bind: "tailnet"` — это прямая привязка к Tailnet (без HTTPS, без Serve/Funnel).
- `gateway.bind: "auto"` предпочитает loopback; используйте `tailnet`, если нужен только tailnet.
- Serve/Funnel публикуют только **панель управления Gateway + WS**. Узлы подключаются
  через тот же WS‑endpoint Gateway, поэтому Serve может работать и для доступа узлов.

## Управление браузером (удалённый Gateway + локальный браузер)

Если вы запускаете Gateway на одной машине, но хотите управлять браузером на другой,
запустите **хост узла** на машине с браузером и держите обе в одном tailnet.
Gateway будет проксировать действия браузера к узлу; отдельный сервер управления или URL Serve не требуется.

Избегайте Funnel для управления браузером; относитесь к сопряжению узлов как к операторскому доступу.

## Предварительные требования и ограничения Tailscale

- Serve требует включённый HTTPS для вашего tailnet; CLI подскажет, если его нет.
- Serve внедряет заголовки идентификации Tailscale; Funnel — нет.
- Funnel требует Tailscale v1.38.3+, MagicDNS, включённый HTTPS и атрибут узла funnel.
- Funnel поддерживает по TLS только порты `443`, `8443` и `10000`.
- Funnel на macOS требует вариант приложения Tailscale с открытым исходным кодом.

## Узнать больше

- Обзор Tailscale Serve: [https://tailscale.com/kb/1312/serve](https://tailscale.com/kb/1312/serve)
- Команда `tailscale serve`: [https://tailscale.com/kb/1242/tailscale-serve](https://tailscale.com/kb/1242/tailscale-serve)
- Обзор Tailscale Funnel: [https://tailscale.com/kb/1223/tailscale-funnel](https://tailscale.com/kb/1223/tailscale-funnel)
- Команда `tailscale funnel`: [https://tailscale.com/kb/1311/tailscale-funnel](https://tailscale.com/kb/1311/tailscale-funnel)
