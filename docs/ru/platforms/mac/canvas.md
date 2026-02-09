---
summary: "Панель Canvas, встроенная через WKWebView и управляемая агентом + пользовательская схема URL"
read_when:
  - Реализация панели Canvas в macOS
  - Добавление агентных элементов управления для визуального рабочего пространства
  - Отладка загрузок Canvas в WKWebView
title: "Canvas"
---

# Canvas (приложение для macOS)

Приложение для macOS встраивает управляемую агентом **панель Canvas** с использованием `WKWebView`. Это
лёгкое визуальное рабочее пространство для HTML/CSS/JS, A2UI и небольших интерактивных
UI‑поверхностей.

## Где находится Canvas

Состояние Canvas хранится в Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Панель Canvas обслуживает эти файлы через **пользовательскую схему URL**:

- `openclaw-canvas://<session>/<path>`

Примеры:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Если в корне отсутствует `index.html`, приложение показывает **встроенную страницу‑заготовку**.

## Поведение панели

- Безрамочная, изменяемая по размеру панель, закреплённая рядом со строкой меню (или курсором мыши).
- Запоминает размер и позицию для каждого сеанса.
- Автоматически перезагружается при изменении локальных файлов Canvas.
- Одновременно видна только одна панель Canvas (при необходимости сеанс переключается).

Canvas можно отключить в Настройках → **Allow Canvas**. В отключённом состоянии команды узла canvas возвращают `CANVAS_DISABLED`.

## API агента

Canvas доступен через **Gateway WebSocket**, поэтому агент может:

- показывать/скрывать панель
- переходить по пути или URL
- выполнять JavaScript
- захватывать снимок изображения

Примеры CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Примечания:

- `canvas.navigate` принимает **локальные пути Canvas**, URL `http(s)` и URL `file://`.
- Если передать `"/"`, Canvas покажет локальную заготовку или `index.html`.

## A2UI в Canvas

A2UI размещается хостом Canvas шлюза Gateway и отображается внутри панели Canvas.
Когда Gateway объявляет хост Canvas, приложение для macOS автоматически
переходит на страницу хоста A2UI при первом открытии.

URL хоста A2UI по умолчанию:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### Команды A2UI (v0.8)

Canvas в настоящее время принимает сообщения сервер→клиент **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) не поддерживается.

Пример CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Быстрая проверка:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Запуск агентных прогонов из Canvas

Canvas может запускать новые прогоны агента через deep links:

- `openclaw://agent?...`

Пример (в JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

Приложение запрашивает подтверждение, если не предоставлен действительный ключ.

## Примечания по безопасности

- Схема Canvas блокирует обход каталогов; файлы должны находиться в пределах корня сеанса.
- Локальный контент Canvas использует пользовательскую схему (сервер loopback не требуется).
- Внешние URL `http(s)` разрешены только при явной навигации.
