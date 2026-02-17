---
summary: "Nodos: emparejamiento, capacidades, permisos y ayudantes CLI para canvas/cámara/pantalla/sistema"
read_when:
  - Emparejar nodos iOS/Android a un gateway
  - Usar canvas/cámara de nodo para contexto del agente
  - Agregar nuevos comandos de nodo o ayudantes CLI
title: "Nodos"
---

# Nodos

Un **nodo** es un dispositivo complementario (macOS/iOS/Android/headless) que se conecta al **WebSocket** del Gateway (mismo puerto que los operadores) con `role: "node"` y expone una superficie de comandos (ej. `canvas.*`, `camera.*`, `system.*`) mediante `node.invoke`. Detalles del protocolo: [Protocolo del Gateway](/es-ES/gateway/protocol).

Transporte heredado: [Protocolo Bridge](/es-ES/gateway/bridge-protocol) (TCP JSONL; obsoleto/eliminado para nodos actuales).

macOS también puede ejecutarse en **modo nodo**: la aplicación de la barra de menú se conecta al servidor WS del Gateway y expone sus comandos locales de canvas/cámara como un nodo (para que `openclaw nodes …` funcione contra esta Mac).

Notas:

- Los nodos son **periféricos**, no gateways. No ejecutan el servicio de gateway.
- Los mensajes de Telegram/WhatsApp/etc. llegan al **gateway**, no a los nodos.
- Guía de solución de problemas: [/es-ES/nodes/troubleshooting](/es-ES/nodes/troubleshooting)

## Emparejamiento + estado

**Los nodos WS usan emparejamiento de dispositivos.** Los nodos presentan una identidad de dispositivo durante `connect`; el Gateway crea una solicitud de emparejamiento de dispositivo para `role: node`. Aprobar mediante CLI de dispositivos (o interfaz).

CLI rápido:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Notas:

- `nodes status` marca un nodo como **emparejado** cuando su rol de emparejamiento de dispositivo incluye `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) es un almacén de emparejamiento de nodos independiente propiedad del gateway; **no** controla el handshake de `connect` WS.

## Host de nodo remoto (system.run)

Usa un **host de nodo** cuando tu Gateway se ejecuta en una máquina y quieres que los comandos se ejecuten en otra. El modelo aún habla con el **gateway**; el gateway reenvía llamadas `exec` al **host de nodo** cuando se selecciona `host=node`.

### Qué se ejecuta dónde

- **Host del Gateway**: recibe mensajes, ejecuta el modelo, enruta llamadas a herramientas.
- **Host del nodo**: ejecuta `system.run`/`system.which` en la máquina del nodo.
- **Aprobaciones**: aplicadas en el host del nodo mediante `~/.openclaw/exec-approvals.json`.

### Iniciar un host de nodo (primer plano)

En la máquina del nodo:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Gateway remoto mediante túnel SSH (enlace loopback)

Si el Gateway se enlaza a loopback (`gateway.bind=loopback`, predeterminado en modo local), los hosts de nodo remotos no pueden conectarse directamente. Crea un túnel SSH y apunta el host del nodo al extremo local del túnel.

Ejemplo (host de nodo -> host de gateway):

```bash
# Terminal A (mantener ejecutándose): reenviar 18790 local -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: exportar el token del gateway y conectar a través del túnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

Notas:

- El token es `gateway.auth.token` de la configuración del gateway (`~/.openclaw/openclaw.json` en el host del gateway).
- `openclaw node run` lee `OPENCLAW_GATEWAY_TOKEN` para autenticación.

### Iniciar un host de nodo (servicio)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### Emparejar + nombrar

En el host del gateway:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

Opciones de nomenclatura:

- `--display-name` en `openclaw node run` / `openclaw node install` (persiste en `~/.openclaw/node.json` en el nodo).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (anulación del gateway).

### Incluir comandos en la lista permitida

Las aprobaciones de ejecución son **por host de nodo**. Agrega entradas de lista permitida desde el gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Las aprobaciones se encuentran en el host del nodo en `~/.openclaw/exec-approvals.json`.

### Apuntar exec al nodo

Configurar valores predeterminados (configuración del gateway):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

O por sesión:

```
/exec host=node security=allowlist node=<id-or-name>
```

Una vez configurado, cualquier llamada `exec` con `host=node` se ejecuta en el host del nodo (sujeto a la lista permitida/aprobaciones del nodo).

Relacionado:

- [CLI de host de nodo](/es-ES/cli/node)
- [Herramienta Exec](/es-ES/tools/exec)
- [Aprobaciones Exec](/es-ES/tools/exec-approvals)

## Invocar comandos

Bajo nivel (RPC sin procesar):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Existen ayudantes de nivel superior para los flujos de trabajo comunes de "dar al agente un adjunto MEDIA".

## Capturas de pantalla (instantáneas de canvas)

Si el nodo muestra el Canvas (WebView), `canvas.snapshot` devuelve `{ format, base64 }`.

Ayudante CLI (escribe en un archivo temporal e imprime `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Controles de Canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notas:

- `canvas present` acepta URLs o rutas de archivos locales (`--target`), más `--x/--y/--width/--height` opcionales para posicionamiento.
- `canvas eval` acepta JS en línea (`--js`) o un argumento posicional.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notas:

- Solo se admite A2UI v0.8 JSONL (v0.9/createSurface es rechazado).

## Fotos + videos (cámara del nodo)

Fotos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # predeterminado: ambas orientaciones (2 líneas MEDIA)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Clips de video (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notas:

- El nodo debe estar **en primer plano** para `canvas.*` y `camera.*` (las llamadas en segundo plano devuelven `NODE_BACKGROUND_UNAVAILABLE`).
- La duración del clip está limitada (actualmente `<= 60s`) para evitar cargas base64 sobredimensionadas.
- Android solicitará permisos `CAMERA`/`RECORD_AUDIO` cuando sea posible; los permisos denegados fallan con `*_PERMISSION_REQUIRED`.

## Grabaciones de pantalla (nodos)

Los nodos exponen `screen.record` (mp4). Ejemplo:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notas:

- `screen.record` requiere que la aplicación del nodo esté en primer plano.
- Android mostrará el aviso de captura de pantalla del sistema antes de grabar.
- Las grabaciones de pantalla están limitadas a `<= 60s`.
- `--no-audio` deshabilita la captura de micrófono (compatible con iOS/Android; macOS usa audio de captura del sistema).
- Usa `--screen <index>` para seleccionar una pantalla cuando hay múltiples pantallas disponibles.

## Ubicación (nodos)

Los nodos exponen `location.get` cuando la ubicación está habilitada en la configuración.

Ayudante CLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notas:

- La ubicación está **desactivada de forma predeterminada**.
- "Siempre" requiere permiso del sistema; la obtención en segundo plano es de mejor esfuerzo.
- La respuesta incluye lat/lon, precisión (metros) y marca de tiempo.

## SMS (nodos Android)

Los nodos Android pueden exponer `sms.send` cuando el usuario otorga el permiso **SMS** y el dispositivo admite telefonía.

Invocación de bajo nivel:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notas:

- El aviso de permiso debe aceptarse en el dispositivo Android antes de que se anuncie la capacidad.
- Los dispositivos solo Wi-Fi sin telefonía no anunciarán `sms.send`.

## Comandos del sistema (host de nodo / nodo mac)

El nodo macOS expone `system.run`, `system.notify` y `system.execApprovals.get/set`.
El host de nodo headless expone `system.run`, `system.which` y `system.execApprovals.get/set`.

Ejemplos:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

Notas:

- `system.run` devuelve stdout/stderr/código de salida en la carga útil.
- `system.notify` respeta el estado del permiso de notificaciones en la aplicación macOS.
- `system.run` admite `--cwd`, `--env KEY=VAL`, `--command-timeout` y `--needs-screen-recording`.
- `system.notify` admite `--priority <passive|active|timeSensitive>` y `--delivery <system|overlay|auto>`.
- Los hosts de nodo ignoran las anulaciones de `PATH`. Si necesitas entradas adicionales de PATH, configura el entorno del servicio de host de nodo (o instala herramientas en ubicaciones estándar) en lugar de pasar `PATH` mediante `--env`.
- En modo nodo macOS, `system.run` está controlado por aprobaciones exec en la aplicación macOS (Configuración → Aprobaciones Exec).
  Preguntar/lista permitida/completo se comportan igual que el host de nodo headless; los avisos denegados devuelven `SYSTEM_RUN_DENIED`.
- En host de nodo headless, `system.run` está controlado por aprobaciones exec (`~/.openclaw/exec-approvals.json`).

## Vinculación de nodo exec

Cuando hay múltiples nodos disponibles, puedes vincular exec a un nodo específico.
Esto establece el nodo predeterminado para `exec host=node` (y puede anularse por agente).

Predeterminado global:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

Anulación por agente:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

Desestablecer para permitir cualquier nodo:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Mapa de permisos

Los nodos pueden incluir un mapa `permissions` en `node.list` / `node.describe`, con clave por nombre de permiso (ej. `screenRecording`, `accessibility`) con valores booleanos (`true` = otorgado).

## Host de nodo headless (multiplataforma)

OpenClaw puede ejecutar un **host de nodo headless** (sin interfaz) que se conecta al WebSocket del Gateway y expone `system.run` / `system.which`. Esto es útil en Linux/Windows o para ejecutar un nodo mínimo junto a un servidor.

Iniciarlo:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notas:

- Aún se requiere emparejamiento (el Gateway mostrará un aviso de aprobación de nodo).
- El host del nodo almacena su ID de nodo, token, nombre para mostrar e información de conexión del gateway en `~/.openclaw/node.json`.
- Las aprobaciones exec se aplican localmente mediante `~/.openclaw/exec-approvals.json`
  (ver [Aprobaciones Exec](/es-ES/tools/exec-approvals)).
- En macOS, el host de nodo headless prefiere el host exec de la aplicación complementaria cuando es accesible y recurre a la ejecución local si la aplicación no está disponible. Establece `OPENCLAW_NODE_EXEC_HOST=app` para requerir la aplicación, o `OPENCLAW_NODE_EXEC_FALLBACK=0` para deshabilitar el respaldo.
- Agrega `--tls` / `--tls-fingerprint` cuando el WS del Gateway use TLS.

## Modo nodo Mac

- La aplicación de la barra de menú de macOS se conecta al servidor WS del Gateway como un nodo (para que `openclaw nodes …` funcione contra esta Mac).
- En modo remoto, la aplicación abre un túnel SSH para el puerto del Gateway y se conecta a `localhost`.
