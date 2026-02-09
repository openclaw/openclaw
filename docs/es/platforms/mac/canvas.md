---
summary: "Panel Canvas controlado por el agente incrustado mediante WKWebView + esquema de URL personalizado"
read_when:
  - Implementación del panel Canvas en macOS
  - Adición de controles del agente para el espacio de trabajo visual
  - Depuración de cargas de Canvas en WKWebView
title: "Canvas"
---

# Canvas (app macOS)

La app de macOS incrusta un **panel Canvas** controlado por el agente usando `WKWebView`. Es
un espacio de trabajo visual ligero para HTML/CSS/JS, A2UI y pequeñas superficies
de UI interactivas.

## Dónde vive Canvas

El estado de Canvas se almacena en Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

El panel Canvas sirve esos archivos mediante un **esquema de URL personalizado**:

- `openclaw-canvas://<session>/<path>`

Ejemplos:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Si no existe `index.html` en la raíz, la app muestra una **página de andamiaje integrada**.

## Comportamiento del panel

- Panel sin bordes, redimensionable, anclado cerca de la barra de menú (o del cursor del mouse).
- Recuerda tamaño/posición por sesión.
- Se recarga automáticamente cuando cambian los archivos locales del canvas.
- Solo hay un panel Canvas visible a la vez (la sesión se cambia según sea necesario).

Canvas puede deshabilitarse desde Ajustes → **Permitir Canvas**. Cuando está deshabilitado, los
comandos de nodo de canvas devuelven `CANVAS_DISABLED`.

## Superficie de API del agente

Canvas se expone a través del **Gateway WebSocket**, por lo que el agente puede:

- mostrar/ocultar el panel
- navegar a una ruta o URL
- evaluar JavaScript
- capturar una imagen instantánea

Ejemplos de CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Notas:

- `canvas.navigate` acepta **rutas locales del canvas**, URL `http(s)` y URL `file://`.
- Si pasa `"/"`, Canvas muestra el andamiaje local o `index.html`.

## A2UI en Canvas

A2UI es alojado por el host del canvas del Gateway y se renderiza dentro del panel Canvas.
Cuando el Gateway anuncia un host de Canvas, la app de macOS navega automáticamente a la
página del host de A2UI en la primera apertura.

URL predeterminada del host de A2UI:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### Comandos de A2UI (v0.8)

Actualmente, Canvas acepta mensajes de servidor→cliente de **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) no es compatible.

Ejemplo de CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Prueba rápida:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Activar ejecuciones del agente desde Canvas

Canvas puede activar nuevas ejecuciones del agente mediante enlaces profundos:

- `openclaw://agent?...`

Ejemplo (en JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

La app solicita confirmación a menos que se proporcione una clave válida.

## Notas de seguridad

- El esquema de Canvas bloquea el recorrido de directorios; los archivos deben vivir bajo la raíz de la sesión.
- El contenido local de Canvas usa un esquema personalizado (no se requiere un servidor de loopback).
- Las URL externas `http(s)` solo se permiten cuando se navega explícitamente.
