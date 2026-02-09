---
summary: "Приложение Android (узел): ранбук подключения + Canvas/Chat/Camera"
read_when:
  - Сопряжение или повторное подключение узла Android
  - Отладка обнаружения шлюза Gateway или аутентификации на Android
  - Проверка совпадения истории чатов между клиентами
title: "Приложение Android"
---

# Приложение Android (узел)

## Снимок поддержки

- Роль: приложение сопутствующего узла (Android не размещает Gateway (шлюз)).
- Требуется Gateway (шлюз): да (запускается на macOS, Linux или Windows через WSL2).
- Установка: [Начало работы](/start/getting-started) + [Сопряжение](/gateway/pairing).
- Gateway (шлюз): [Runbook](/gateway) + [Конфигурация](/gateway/configuration).
  - Протоколы: [Протокол Gateway (шлюз)](/gateway/protocol) (узлы + плоскость управления).

## Управление системой

Управление системой (launchd/systemd) находится на хосте шлюза Gateway. См. [Gateway](/gateway).

## Ранбук подключения

Приложение узла Android ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway (шлюз)**

Android подключается напрямую к WebSocket шлюза Gateway (по умолчанию `ws://<host>:18789`) и использует сопряжение, управляемое Gateway.

### Предварительные требования

- Вы можете запустить Gateway (шлюз) на «главной» машине.
- Устройство/эмулятор Android может достучаться до WebSocket шлюза Gateway:
  - Та же локальная сеть с mDNS/NSD, **или**
  - Тот же tailnet Tailscale с Wide-Area Bonjour / unicast DNS-SD (см. ниже), **или**
  - Ручной ввод хоста/порта шлюза Gateway (резервный вариант)
- Вы можете запускать CLI (`openclaw`) на машине шлюза Gateway (или через SSH).

### 1. Запуск Gateway (шлюза)

```bash
openclaw gateway --port 18789 --verbose
```

Убедитесь в логах, что вы видите что-то вроде:

- `listening on ws://0.0.0.0:18789`

Для конфигураций только через tailnet (рекомендуется для Вена ⇄ Лондон) привяжите шлюз к IP tailnet:

- Установите `gateway.bind: "tailnet"` в `~/.openclaw/openclaw.json` на хосте шлюза Gateway.
- Перезапустите Gateway / приложение macOS в строке меню.

### 2. Проверка обнаружения (необязательно)

С машины шлюза Gateway:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

Дополнительные заметки по отладке: [Bonjour](/gateway/bonjour).

#### Обнаружение через Tailnet (Вена ⇄ Лондон) с использованием unicast DNS-SD

Обнаружение Android через NSD/mDNS не работает между сетями. Если узел Android и шлюз Gateway находятся в разных сетях, но соединены через Tailscale, используйте Wide-Area Bonjour / unicast DNS-SD:

1. Настройте зону DNS-SD (пример `openclaw.internal.`) на хосте шлюза Gateway и опубликуйте записи `_openclaw-gw._tcp`.
2. Настройте split DNS в Tailscale для выбранного домена, указывая на этот DNS-сервер.

Подробности и пример конфигурации CoreDNS: [Bonjour](/gateway/bonjour).

### 3. Подключение с Android

В приложении Android:

- Приложение поддерживает соединение со шлюзом Gateway через **foreground service** (постоянное уведомление).
- Откройте **Settings**.
- В разделе **Discovered Gateways** выберите ваш шлюз и нажмите **Connect**.
- Если mDNS заблокирован, используйте **Advanced → Manual Gateway** (хост + порт) и **Connect (Manual)**.

После первого успешного сопряжения Android автоматически переподключается при запуске:

- К ручному endpoint (если включён), иначе
- К последнему обнаруженному шлюзу (best-effort).

### 4. Подтвердите сопряжение (CLI)

На машине шлюза Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

Подробности сопряжения: [Сопряжение Gateway](/gateway/pairing).

### 5. Проверьте, что узел подключён

- Через статус узлов:

  ```bash
  openclaw nodes status
  ```

- Через Gateway:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. Чат + история

Лист Chat узла Android использует **основной ключ сеанса** шлюза Gateway (`main`), поэтому история и ответы общие с WebChat и другими клиентами:

- История: `chat.history`
- Отправка: `chat.send`
- Push-обновления (best-effort): `chat.subscribe` → `event:"chat"`

### 7. Canvas + камера

#### Хост Canvas Gateway (рекомендуется для веб-контента)

Если вы хотите, чтобы узел отображал реальный HTML/CSS/JS, который агент может редактировать на диске, направьте узел на хост Canvas шлюза Gateway.

Примечание: узлы используют автономный хост Canvas на `canvasHost.port` (по умолчанию `18793`).

1. Создайте `~/.openclaw/workspace/canvas/index.html` на хосте шлюза Gateway.

2. Откройте его на узле (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (необязательно): если оба устройства подключены к Tailscale, используйте имя MagicDNS или IP tailnet вместо `.local`, например `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

Этот сервер внедряет клиент live-reload в HTML и перезагружает страницу при изменениях файлов.
Хост A2UI доступен по адресу `http://<gateway-host>:18793/__openclaw__/a2ui/`.

Команды Canvas (только на переднем плане):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (используйте `{"url":""}` или `{"url":"/"}`, чтобы вернуться к стандартному каркасу). `canvas.snapshot` возвращает `{ format, base64 }` (по умолчанию `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` — устаревший псевдоним)

Команды камеры (только на переднем плане; с проверкой разрешений):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

См. [Узел камеры](/nodes/camera) для параметров и помощников CLI.
