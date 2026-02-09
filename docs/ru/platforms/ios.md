---
summary: "Приложение узла iOS: подключение к Gateway (шлюз), сопряжение, canvas и устранение неполадок"
read_when:
  - Сопряжение или повторное подключение узла iOS
  - Запуск приложения iOS из исходников
  - Отладка обнаружения шлюза Gateway или команд canvas
title: "Приложение iOS"
---

# Приложение iOS (узел)

Доступность: внутренний превью. Приложение iOS пока не распространяется публично.

## Что оно делает

- Подключается к Gateway (шлюз) по WebSocket (LAN или tailnet).
- Предоставляет возможности узла: Canvas, снимок экрана, захват с камеры, местоположение, режим разговора, голосовую активацию.
- Принимает команды `node.invoke` и отправляет события состояния узла.

## Требования

- Gateway (шлюз), запущенный на другом устройстве (macOS, Linux или Windows через WSL2).
- Сетевой путь:
  - Та же LAN через Bonjour, **или**
  - Tailnet через одноадресный DNS-SD (пример домена: `openclaw.internal.`), **или**
  - Ручной ввод хоста/порта (резервный вариант).

## Быстрый старт (сопряжение + подключение)

1. Запустите Gateway (шлюз):

```bash
openclaw gateway --port 18789
```

2. В приложении iOS откройте Settings и выберите обнаруженный шлюз Gateway (или включите Manual Host и введите хост/порт).

3. Подтвердите запрос на сопряжение на хосте шлюза Gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. Проверьте подключение:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Пути обнаружения

### Bonjour (LAN)

Gateway (шлюз) объявляет `_openclaw-gw._tcp` на `local.`. Приложение iOS автоматически отображает такие объявления.

### Tailnet (межсетевое)

Если mDNS заблокирован, используйте одноадресную зону DNS-SD (выберите домен; пример: `openclaw.internal.`) и split DNS в Tailscale.
См. [Bonjour](/gateway/bonjour) для примера CoreDNS.

### Ручной хост/порт

В Settings включите **Manual Host** и введите хост шлюза Gateway и порт (по умолчанию `18789`).

## Canvas + A2UI

Узел iOS рендерит canvas в WKWebView. Используйте `node.invoke` для управления им:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

Примечания:

- Хост canvas шлюза Gateway обслуживает `/__openclaw__/canvas/` и `/__openclaw__/a2ui/`.
- Узел iOS автоматически переходит к A2UI при подключении, если объявлен URL хоста canvas.
- Возврат к встроенному шаблону выполняется с помощью `canvas.navigate` и `{"url":""}`.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Голосовая активация и режим разговора

- Голосовая активация и режим разговора доступны в Settings.
- iOS может приостанавливать фоновое аудио; рассматривайте голосовые функции как best‑effort, когда приложение не активно.

## Частые ошибки

- `NODE_BACKGROUND_UNAVAILABLE`: переведите приложение iOS на передний план (команды canvas/камеры/экрана требуют этого).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway (шлюз) не объявил URL хоста canvas; проверьте `canvasHost` в [Конфигурация шлюза Gateway](/gateway/configuration).
- Окно сопряжения не появляется: выполните `openclaw nodes pending` и подтвердите вручную.
- Повторное подключение не удаётся после переустановки: токен сопряжения в Keychain был очищен; выполните повторное сопряжение узла.

## Связанная документация

- [Сопряжение](/gateway/pairing)
- [Обнаружение](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
