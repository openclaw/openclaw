---
summary: "Среда выполнения Gateway (шлюз) на macOS (внешний сервис launchd)"
read_when:
  - Упаковка OpenClaw.app
  - Отладка сервиса launchd Gateway (шлюз) на macOS
  - Установка CLI Gateway (шлюз) для macOS
title: "Gateway (шлюз) на macOS"
---

# Gateway (шлюз) на macOS (внешний launchd)

OpenClaw.app больше не включает Node/Bun или среду выполнения Gateway (шлюз). Приложение для macOS
ожидает **внешнюю** установку CLI `openclaw`, не запускает Gateway (шлюз) как
дочерний процесс и управляет пользовательским сервисом launchd, чтобы поддерживать
работу Gateway (шлюз) (или подключается к существующему локальному Gateway (шлюз), если он уже запущен).

## Установка CLI (обязательно для локального режима)

На Mac требуется Node 22+, затем установите `openclaw` глобально:

```bash
npm install -g openclaw@<version>
```

Кнопка **Install CLI** в приложении для macOS запускает тот же процесс через npm/pnpm (bun не рекомендуется для среды выполнения Gateway (шлюз)).

## Launchd (Gateway (шлюз) как LaunchAgent)

Метка:

- `bot.molt.gateway` (или `bot.molt.<profile>`; устаревшая `com.openclaw.*` может сохраняться)

Расположение plist (для пользователя):

- `~/Library/LaunchAgents/bot.molt.gateway.plist`
  (или `~/Library/LaunchAgents/bot.molt.<profile>.plist`)

Управление:

- Приложение для macOS управляет установкой/обновлением LaunchAgent в локальном режиме.
- CLI также может установить его: `openclaw gateway install`.

Поведение:

- «OpenClaw Active» включает/выключает LaunchAgent.
- Закрытие приложения **не** останавливает gateway (launchd поддерживает его работу).
- Если Gateway (шлюз) уже запущен на настроенном порту, приложение подключается к нему
  вместо запуска нового экземпляра.

Метка:

- stdout/err launchd: `/tmp/openclaw/openclaw-gateway.log`

## Совместимость версий

Приложение для macOS проверяет версию Gateway (шлюз) на соответствие собственной версии. Если они
несовместимы, обновите глобальный CLI до версии, соответствующей версии приложения.

## Дым

```bash
openclaw --version

OPENCLAW_SKIP_CHANNELS=1 \
OPENCLAW_SKIP_CANVAS_HOST=1 \
openclaw gateway --port 18999 --bind loopback
```

Затем:

```bash
openclaw gateway call health --url ws://127.0.0.1:18999 --timeout 3000
```
