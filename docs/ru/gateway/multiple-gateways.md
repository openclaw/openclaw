---
summary: "Запуск нескольких Gateway OpenClaw на одном хосте (изоляция, порты и профили)"
read_when:
  - Запуск более одного Gateway на одной машине
  - Требуется изоляция конфигурации/состояния/портов для каждого Gateway
title: "Несколько Gateway"
---

# Несколько Gateway (один и тот же хост)

В большинстве установок следует использовать один Gateway, поскольку один Gateway может обслуживать несколько подключений к мессенджерам и агентов. Если требуется более строгая изоляция или резервирование (например, rescue-бот), запускайте отдельные Gateway с изолированными профилями и портами.

## Чек-лист изоляции (обязательно)

- `OPENCLAW_CONFIG_PATH` — файл конфига для каждого экземпляра
- `OPENCLAW_STATE_DIR` — сессии, учётные данные и кэши для каждого экземпляра
- `agents.defaults.workspace` — корень рабочего пространства для каждого экземпляра
- `gateway.port` (или `--port`) — уникально для каждого экземпляра
- Производные порты (browser/canvas) не должны пересекаться

Если что-либо из этого разделяется, вы столкнётесь с гонками конфига и конфликтами портов.

## Рекомендуется: профили (`--profile`)

Профили автоматически изолируют `OPENCLAW_STATE_DIR` + `OPENCLAW_CONFIG_PATH` и добавляют суффиксы к именам сервисов.

```bash
# main
openclaw --profile main setup
openclaw --profile main gateway --port 18789

# rescue
openclaw --profile rescue setup
openclaw --profile rescue gateway --port 19001
```

Сервисы для каждого профиля:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

## Руководство по rescue-боту

Запустите второй Gateway на том же хосте со своими собственными:

- профилем/конфигом
- каталог штата
- рабочим пространством
- базовым портом (плюс производные порты)

Это сохраняет изоляцию rescue-бота от основного бота, чтобы он мог отлаживать или применять изменения конфига, если основной бот недоступен.

Разнос портов: оставляйте не менее 20 портов между базовыми портами, чтобы производные порты browser/canvas/CDP никогда не пересекались.

### Как установить (rescue-бот)

```bash
# Main bot (existing or fresh, without --profile param)
# Runs on port 18789 + Chrome CDC/Canvas/... Ports
openclaw onboard
openclaw gateway install

# Rescue bot (isolated profile + ports)
openclaw --profile rescue onboard
# Notes:
# - workspace name will be postfixed with -rescue per default
# - Port should be at least 18789 + 20 Ports,
#   better choose completely different base port, like 19789,
# - rest of the onboarding is the same as normal

# To install the service (if not happened automatically during onboarding)
openclaw --profile rescue gateway install
```

## Сопоставление портов (производные)

Базовый порт = `gateway.port` (или `OPENCLAW_GATEWAY_PORT` / `--port`).

- порт сервиса управления браузером = базовый + 2 (только local loopback)
- `canvasHost.port = base + 4`
- Порты CDP профиля браузера автоматически выделяются из `browser.controlPort + 9 .. + 108`

Если вы переопределяете любой из них в конфиге или через переменные окружения, необходимо сохранять уникальность для каждого экземпляра.

## Примечания по Browser/CDP (распространённая ловушка)

- **Не** фиксируйте `browser.cdpUrl` на одинаковые значения для нескольких экземпляров.
- Каждому экземпляру требуется собственный порт управления браузером и диапазон CDP (производные от порта шлюза).
- Если нужны явные порты CDP, задавайте `browser.profiles.<name>.cdpPort` для каждого экземпляра.
- Удалённый Chrome: используйте `browser.profiles.<name>.cdpUrl` (на профиль, на экземпляр).

## Пример ручной настройки env

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/main.json \
OPENCLAW_STATE_DIR=~/.openclaw-main \
openclaw gateway --port 18789

OPENCLAW_CONFIG_PATH=~/.openclaw/rescue.json \
OPENCLAW_STATE_DIR=~/.openclaw-rescue \
openclaw gateway --port 19001
```

## Быстрые проверки

```bash
openclaw --profile main status
openclaw --profile rescue status
openclaw --profile rescue browser status
```
