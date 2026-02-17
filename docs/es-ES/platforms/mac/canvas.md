---
summary: "Panel Canvas controlado por agente embebido vía WKWebView + esquema URL personalizado"
read_when:
  - Implementando el panel Canvas de macOS
  - Agregando controles de agente para espacio de trabajo visual
  - Depurando cargas de canvas WKWebView
title: "Lienzo"
---

# Lienzo (aplicación macOS)

La aplicación macOS embebe un **panel Canvas** controlado por agente usando `WKWebView`. Es
un espacio de trabajo visual ligero para HTML/CSS/JS, A2UI, y pequeñas superficies
UI interactivas.

## Dónde vive Canvas

El estado de Canvas se almacena en Application Support:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

El panel Canvas sirve esos archivos vía un **esquema URL personalizado**:

- `openclaw-canvas://<session>/<path>`

Ejemplos:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

Si no existe `index.html` en la raíz, la aplicación muestra una **página andamio incorporada**.

## Comportamiento del panel

- Panel sin bordes, redimensionable anclado cerca de la barra de menús (o cursor del ratón).
- Recuerda tamaño/posición por sesión.
- Se recarga automáticamente cuando los archivos de canvas locales cambian.
- Solo un panel Canvas es visible a la vez (la sesión se cambia según sea necesario).

Canvas puede deshabilitarse desde Configuración → **Permitir Canvas**. Cuando está deshabilitado, los comandos
de nodo de canvas retornan `CANVAS_DISABLED`.

## Superficie API del agente

Canvas se expone vía el **WebSocket del Gateway**, para que el agente pueda:

- mostrar/ocultar el panel
- navegar a una ruta o URL
- evaluar JavaScript
- capturar una imagen instantánea

Ejemplos CLI:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

Notas:

- `canvas.navigate` acepta **rutas de canvas locales**, URLs `http(s)`, y URLs `file://`.
- Si pasas `"/"`, el Canvas muestra el andamio local o `index.html`.

## A2UI en Canvas

A2UI es alojado por el host de canvas del Gateway y renderizado dentro del panel Canvas.
Cuando el Gateway anuncia un host Canvas, la aplicación macOS navega automáticamente a la
página host A2UI en la primera apertura.

URL predeterminada del host A2UI:

```
http://<gateway-host>:18789/__openclaw__/a2ui/
```

### Comandos A2UI (v0.8)

Canvas actualmente acepta mensajes servidor→cliente **A2UI v0.8**:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) no está soportado.

Ejemplo CLI:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"Si puedes leer esto, A2UI push funciona."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Prueba rápida:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hola desde A2UI"
```

## Desencadenar ejecuciones de agente desde Canvas

Canvas puede desencadenar nuevas ejecuciones de agente vía enlaces profundos:

- `openclaw://agent?...`

Ejemplo (en JS):

```js
window.location.href = "openclaw://agent?message=Revisar%20este%20diseño";
```

La aplicación solicita confirmación a menos que se proporcione una clave válida.

## Notas de seguridad

- El esquema Canvas bloquea traversal de directorios; los archivos deben vivir bajo la raíz de sesión.
- El contenido Canvas local usa un esquema personalizado (no se requiere servidor loopback).
- Las URLs externas `http(s)` están permitidas solo cuando se navega explícitamente.
