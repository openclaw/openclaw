---
summary: "Исправление проблем запуска CDP Chrome/Brave/Edge/Chromium для управления браузером OpenClaw в Linux"
read_when: "Управление браузером не работает в Linux, особенно со snap-версией Chromium"
title: "Устранение неполадок браузера"
---

# Устранение неполадок браузера (Linux)

## Проблема: «Failed to start Chrome CDP on port 18800»

Сервер управления браузером OpenClaw не может запустить Chrome/Brave/Edge/Chromium с ошибкой:

```
{"error":"Error: Failed to start Chrome CDP on port 18800 for profile \"openclaw\"."}
```

### Причина

В Ubuntu (и многих дистрибутивах Linux) установка Chromium по умолчанию — это **пакет snap**. Изоляция AppArmor в snap мешает тому, как OpenClaw запускает и отслеживает процесс браузера.

Команда `apt install chromium` устанавливает заглушку, которая перенаправляет на snap:

```
Note, selecting 'chromium-browser' instead of 'chromium'
chromium-browser is already the newest version (2:1snap1-0ubuntu2).
```

Это НЕ настоящий браузер — это всего лишь обёртка.

### Решение 1: Установить Google Chrome (рекомендуется)

Установите официальный пакет Google Chrome `.deb`, который не изолирован snap:

```bash
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt --fix-broken install -y  # if there are dependency errors
```

Затем обновите конфигурацию OpenClaw (`~/.openclaw/openclaw.json`):

```json
{
  "browser": {
    "enabled": true,
    "executablePath": "/usr/bin/google-chrome-stable",
    "headless": true,
    "noSandbox": true
  }
}
```

### Решение 2: Использовать snap Chromium в режиме «только подключение»

Если необходимо использовать snap Chromium, настройте OpenClaw на подключение к браузеру, запущенному вручную:

1. Обновите конфиг:

```json
{
  "browser": {
    "enabled": true,
    "attachOnly": true,
    "headless": true,
    "noSandbox": true
  }
}
```

2. Запустите Chromium вручную:

```bash
chromium-browser --headless --no-sandbox --disable-gpu \
  --remote-debugging-port=18800 \
  --user-data-dir=$HOME/.openclaw/browser/openclaw/user-data \
  about:blank &
```

3. При желании создайте пользовательский сервис systemd для автозапуска Chrome:

```ini
# ~/.config/systemd/user/openclaw-browser.service
[Unit]
Description=OpenClaw Browser (Chrome CDP)
After=network.target

[Service]
ExecStart=/snap/bin/chromium --headless --no-sandbox --disable-gpu --remote-debugging-port=18800 --user-data-dir=%h/.openclaw/browser/openclaw/user-data about:blank
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Включите с помощью: `systemctl --user enable --now openclaw-browser.service`

### Проверка работы браузера

Проверьте статус:

```bash
curl -s http://127.0.0.1:18791/ | jq '{running, pid, chosenBrowser}'
```

Проверьте просмотр страниц:

```bash
curl -s -X POST http://127.0.0.1:18791/start
curl -s http://127.0.0.1:18791/tabs
```

### Справочник конфигурации

| Параметр                 | Описание                                                                                         | Значение по умолчанию                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `browser.enabled`        | Включить управление браузером                                                                    | `true`                                                                                         |
| `browser.executablePath` | Путь к бинарному файлу браузера на базе Chromium (Chrome/Brave/Edge/Chromium) | auto-detected (предпочитает браузер по умолчанию, если он на базе Chromium) |
| `browser.headless`       | Запуск без GUI                                                                                   | `false`                                                                                        |
| `browser.noSandbox`      | Добавить флаг `--no-sandbox` (требуется для некоторых конфигураций Linux)     | `false`                                                                                        |
| `browser.attachOnly`     | Не запускать браузер, только подключаться к существующему                                        | `false`                                                                                        |
| `browser.cdpPort`        | Порт Chrome DevTools Protocol                                                                    | `18800`                                                                                        |

### Проблема: «Chrome extension relay is running, but no tab is connected»

Вы используете профиль `chrome` (extension relay). Он ожидает, что расширение браузера OpenClaw будет подключено к активной вкладке.

Варианты исправления:

1. **Использовать управляемый браузер:** `openclaw browser start --browser-profile openclaw`
   (или установите `browser.defaultProfile: "openclaw"`).
2. **Использовать extension relay:** установите расширение, откройте вкладку и нажмите
   на значок расширения OpenClaw, чтобы подключить его.

Примечания:

- Профиль `chrome` по возможности использует **системный браузер Chromium по умолчанию**.
- Локальные профили `openclaw` автоматически назначают `cdpPort`/`cdpUrl`; задавайте их вручную только для удалённого CDP.
