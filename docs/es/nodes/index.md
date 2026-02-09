---
summary: "Nodos: emparejamiento, capacidades, permisos y ayudas de CLI para canvas/cámara/pantalla/sistema"
read_when:
  - Emparejamiento de nodos iOS/Android con un Gateway
  - Uso del canvas/cámara del nodo para el contexto del agente
  - Agregar nuevos comandos de nodo o ayudas de CLI
title: "Nodos"
---

# Nodos

Un **nodo** es un dispositivo complementario (macOS/iOS/Android/headless) que se conecta al **WebSocket** del Gateway (el mismo puerto que los operadores) con `role: "node"` y expone una superficie de comandos (p. ej., `canvas.*`, `camera.*`, `system.*`) vía `node.invoke`. Detalles del protocolo: [Protocolo del Gateway](/gateway/protocol).

Transporte legado: [Protocolo Bridge](/gateway/bridge-protocol) (TCP JSONL; obsoleto/eliminado para nodos actuales).

macOS también puede ejecutarse en **modo nodo**: la app de la barra de menús se conecta al servidor WS del Gateway y expone sus comandos locales de canvas/cámara como un nodo (para que `openclaw nodes …` funcione contra esta Mac).

Notas:

- Los nodos son **periféricos**, no gateways. No ejecutan el servicio de gateway.
- Los mensajes de Telegram/WhatsApp/etc. llegan al **gateway**, no a los nodos.
- Runbook de solución de problemas: [/nodes/troubleshooting](/nodes/troubleshooting)

## Emparejamiento + estado

**Los nodos WS usan emparejamiento de dispositivos.** Los nodos presentan una identidad de dispositivo durante `connect`; el Gateway
crea una solicitud de emparejamiento de dispositivo para `role: node`. Apruebe mediante la CLI (o la UI) de dispositivos.

CLI rápida:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

Notas:

- `nodes status` marca un nodo como **emparejado** cuando su rol de emparejamiento de dispositivo incluye `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) es un almacén de emparejamiento de nodos independiente, propiedad del gateway; **no** controla el saludo WS `connect`.

## Host de nodo remoto (system.run)

Use un **host de nodo** cuando su Gateway se ejecuta en una máquina y desea que los comandos
se ejecuten en otra. El modelo sigue hablando con el **gateway**; el gateway
reenvía llamadas `exec` al **host de nodo** cuando se selecciona `host=node`.

### Qué se ejecuta dónde

- **Host del Gateway**: recibe mensajes, ejecuta el modelo, enruta llamadas a herramientas.
- **Host de nodo**: ejecuta `system.run`/`system.which` en la máquina del nodo.
- **Aprobaciones**: aplicadas en el host de nodo vía `~/.openclaw/exec-approvals.json`.

### Iniciar un host de nodo (primer plano)

En la máquina del nodo:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### Gateway remoto vía túnel SSH (enlace a loopback)

Si el Gateway se enlaza a loopback (`gateway.bind=loopback`, predeterminado en modo local),
los hosts de nodo remotos no pueden conectarse directamente. Cree un túnel SSH y apunte el
host de nodo al extremo local del túnel.

Ejemplo (host de nodo -> host del gateway):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
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

Opciones de nombre:

- `--display-name` en `openclaw node run` / `openclaw node install` (persiste en `~/.openclaw/node.json` en el nodo).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (anulación del gateway).

### Incluir los comandos en la lista de permitidos

Las aprobaciones de ejecución son **por host de nodo**. Agregue entradas a la lista de permitidos desde el gateway:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

Las aprobaciones viven en el host de nodo en `~/.openclaw/exec-approvals.json`.

### Apuntar exec al nodo

Configure valores predeterminados (configuración del gateway):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

O por sesión:

```
/exec host=node security=allowlist node=<id-or-name>
```

Una vez configurado, cualquier llamada `exec` con `host=node` se ejecuta en el host de nodo (sujeto a la lista de permitidos/aprobaciones del nodo).

Relacionado:

- [CLI del host de nodo](/cli/node)
- [Herramienta exec](/tools/exec)
- [Aprobaciones de exec](/tools/exec-approvals)

## Invocar comandos

Bajo nivel (RPC sin procesar):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

Existen ayudas de nivel superior para los flujos comunes de “darle al agente un adjunto MEDIA”.

## Capturas de pantalla (instantáneas del canvas)

Si el nodo muestra el Canvas (WebView), `canvas.snapshot` devuelve `{ format, base64 }`.

Ayuda de CLI (escribe en un archivo temporal e imprime `MEDIA:<path>`):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### Controles del Canvas

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

Notas:

- `canvas present` acepta URLs o rutas de archivos locales (`--target`), además de `--x/--y/--width/--height` opcional para posicionamiento.
- `canvas eval` acepta JS en línea (`--js`) o un argumento posicional.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

Notas:

- Solo se admite A2UI v0.8 JSONL (v0.9/createSurface se rechaza).

## Fotos + videos (cámara del nodo)

Fotos (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

Clips de video (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

Notas:

- El nodo debe estar **en primer plano** para `canvas.*` y `camera.*` (las llamadas en segundo plano devuelven `NODE_BACKGROUND_UNAVAILABLE`).
- La duración del clip se limita (actualmente `<= 60s`) para evitar cargas base64 sobredimensionadas.
- Android solicitará permisos de `CAMERA`/`RECORD_AUDIO` cuando sea posible; los permisos denegados fallan con `*_PERMISSION_REQUIRED`.

## Grabaciones de pantalla (nodos)

Los nodos exponen `screen.record` (mp4). Ejemplo:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

Notas:

- `screen.record` requiere que la app del nodo esté en primer plano.
- Android mostrará el aviso del sistema para captura de pantalla antes de grabar.
- Las grabaciones de pantalla se limitan a `<= 60s`.
- `--no-audio` deshabilita la captura del micrófono (compatible con iOS/Android; macOS usa el audio de captura del sistema).
- Use `--screen <index>` para seleccionar una pantalla cuando hay varias disponibles.

## Ubicación (nodos)

Los nodos exponen `location.get` cuando Ubicación está habilitada en la configuración.

Ayuda de CLI:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

Notas:

- La Ubicación está **desactivada de forma predeterminada**.
- “Siempre” requiere permiso del sistema; la obtención en segundo plano es de mejor esfuerzo.
- La respuesta incluye lat/lon, precisión (metros) y marca de tiempo.

## SMS (nodos Android)

Los nodos Android pueden exponer `sms.send` cuando el usuario otorga permiso de **SMS** y el dispositivo admite telefonía.

Invocación de bajo nivel:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

Notas:

- El aviso de permisos debe aceptarse en el dispositivo Android antes de que se anuncie la capacidad.
- Los dispositivos solo Wi‑Fi sin telefonía no anunciarán `sms.send`.

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
- `system.notify` respeta el estado de permisos de notificaciones en la app macOS.
- `system.run` admite `--cwd`, `--env KEY=VAL`, `--command-timeout` y `--needs-screen-recording`.
- `system.notify` admite `--priority <passive|active|timeSensitive>` y `--delivery <system|overlay|auto>`.
- Los nodos macOS descartan las anulaciones `PATH`; los hosts de nodo headless solo aceptan `PATH` cuando antepone el PATH del host de nodo.
- En modo nodo de macOS, `system.run` está controlado por aprobaciones de exec en la app macOS (Configuración → Aprobaciones de exec).
  Ask/allowlist/full se comportan igual que el host de nodo headless; las solicitudes denegadas devuelven `SYSTEM_RUN_DENIED`.
- En el host de nodo headless, `system.run` está controlado por aprobaciones de exec (`~/.openclaw/exec-approvals.json`).

## Enlazado del nodo Exec

Cuando hay varios nodos disponibles, puede vincular exec a un nodo específico.
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

Desactivar para permitir cualquier nodo:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## Mapa de permisos

Los nodos pueden incluir un mapa `permissions` en `node.list` / `node.describe`, con claves por nombre de permiso (p. ej., `screenRecording`, `accessibility`) y valores booleanos (`true` = concedido).

## Host de nodo headless (multiplataforma)

OpenClaw puede ejecutar un **host de nodo headless** (sin UI) que se conecta al
WebSocket del Gateway y expone `system.run` / `system.which`. Esto es útil en Linux/Windows
o para ejecutar un nodo mínimo junto a un servidor.

Iniciarlo:

```bash
openclaw node run --host <gateway-host> --port 18789
```

Notas:

- El emparejamiento sigue siendo obligatorio (el Gateway mostrará un aviso de aprobación de nodo).
- El host de nodo almacena su id de nodo, token, nombre para mostrar e información de conexión al gateway en `~/.openclaw/node.json`.
- Las aprobaciones de exec se aplican localmente vía `~/.openclaw/exec-approvals.json`
  (ver [Aprobaciones de exec](/tools/exec-approvals)).
- En macOS, el host de nodo headless prefiere el host de exec de la app complementaria cuando es alcanzable y
  recurre a la ejecución local si la app no está disponible. Configure `OPENCLAW_NODE_EXEC_HOST=app` para requerir
  la app, o `OPENCLAW_NODE_EXEC_FALLBACK=0` para deshabilitar el fallback.
- Agregue `--tls` / `--tls-fingerprint` cuando el WS del Gateway use TLS.

## Modo nodo de Mac

- La app de la barra de menús de macOS se conecta al servidor WS del Gateway como un nodo (para que `openclaw nodes …` funcione contra esta Mac).
- En modo remoto, la app abre un túnel SSH para el puerto del Gateway y se conecta a `localhost`.
