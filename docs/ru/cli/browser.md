---
summary: "Справка CLI для `openclaw browser` (профили, вкладки, действия, реле расширения)"
read_when:
  - Вы используете `openclaw browser` и хотите примеры для типовых задач
  - Вы хотите управлять браузером, запущенным на другой машине, через хост узла
  - Вы хотите использовать реле расширения Chrome (подключение/отключение через кнопку на панели инструментов)
title: "браузер"
---

# `openclaw browser`

Управление сервером управления браузером OpenClaw и выполнение действий в браузере (вкладки, снимки, скриншоты, навигация, клики, ввод текста).

Связанное:

- Инструмент браузера + API: [Browser tool](/tools/browser)
- Реле расширения Chrome: [Chrome extension](/tools/chrome-extension)

## Common flags

- `--url <gatewayWsUrl>`: URL WebSocket Gateway (шлюз) (по умолчанию из конфига).
- `--token <token>`: токен Gateway (шлюз) (если требуется).
- `--timeout <ms>`: таймаут запроса (мс).
- `--browser-profile <name>`: выбор профиля браузера (по умолчанию из конфига).
- `--json`: машиночитаемый вывод (где поддерживается).

## Quick start (local)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## Profiles

Профили — это именованные конфигурации маршрутизации браузера. На практике:

- `openclaw`: запускает/подключается к выделенному экземпляру Chrome под управлением OpenClaw (изолированный каталог пользовательских данных).
- `chrome`: управляет существующими вкладками Chrome через реле расширения Chrome.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

Использовать конкретный профиль:

```bash
openclaw browser --browser-profile work tabs
```

## Tabs

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## Snapshot / screenshot / actions

Снимок:

```bash
openclaw browser snapshot
```

Скриншот:

```bash
openclaw browser screenshot
```

Навигация/клик/ввод текста (автоматизация UI на основе ссылок):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome extension relay (attach via toolbar button)

Этот режим позволяет агенту управлять существующей вкладкой Chrome, которую вы подключаете вручную (автоподключение отсутствует).

Установите распакованное расширение в стабильный путь:

```bash
openclaw browser extension install
openclaw browser extension path
```

Затем Chrome → `chrome://extensions` → включите «Developer mode» → «Load unpacked» → выберите выведенную папку.

Полное руководство: [Chrome extension](/tools/chrome-extension)

## Remote browser control (node host proxy)

Если Gateway (шлюз) работает на другой машине, чем браузер, запустите **хост узла** на машине с Chrome/Brave/Edge/Chromium. Gateway (шлюз) будет проксировать действия браузера к этому узлу (отдельный сервер управления браузером не требуется).

Используйте `gateway.nodes.browser.mode` для управления автоматической маршрутизацией и `gateway.nodes.browser.node` для закрепления конкретного узла, если подключено несколько.

Безопасность и удалённая настройка: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
