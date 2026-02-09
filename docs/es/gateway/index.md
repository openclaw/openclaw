---
summary: "Manual operativo del servicio Gateway, su ciclo de vida y operaciones"
read_when:
  - Al ejecutar o depurar el proceso del gateway
title: "Manual operativo del Gateway"
---

# Manual operativo del servicio Gateway

Última actualización: 2025-12-09

## Qué es

- El proceso siempre activo que posee la conexión única de Baileys/Telegram y el plano de control/eventos.
- Reemplaza el comando heredado `gateway`. Punto de entrada de la CLI: `openclaw gateway`.
- Se ejecuta hasta que se detiene; sale con código distinto de cero en errores fatales para que el supervisor lo reinicie.

## Cómo ejecutar (local)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- La recarga en caliente de configuración observa `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`).
  - Modo predeterminado: `gateway.reload.mode="hybrid"` (aplica en caliente cambios seguros, reinicia en cambios críticos).
  - La recarga en caliente usa reinicio en proceso vía **SIGUSR1** cuando es necesario.
  - Deshabilite con `gateway.reload.mode="off"`.
- Vincula el plano de control WebSocket a `127.0.0.1:<port>` (predeterminado 18789).
- El mismo puerto también sirve HTTP (UI de control, hooks, A2UI). Multiplexado de puerto único.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- Inicia un servidor de archivos Canvas de forma predeterminada en `canvasHost.port` (predeterminado `18793`), sirviendo `http://<gateway-host>:18793/__openclaw__/canvas/` desde `~/.openclaw/workspace/canvas`. Deshabilite con `canvasHost.enabled=false` o `OPENCLAW_SKIP_CANVAS_HOST=1`.
- Registra en stdout; use launchd/systemd para mantenerlo activo y rotar logs.
- Pase `--verbose` para reflejar el registro de depuración (handshakes, req/res, eventos) del archivo de log a stdio al solucionar problemas.
- `--force` usa `lsof` para encontrar listeners en el puerto elegido, envía SIGTERM, registra lo que finalizó y luego inicia el gateway (falla rápido si falta `lsof`).
- Si se ejecuta bajo un supervisor (launchd/systemd/modo proceso-hijo de app mac), una detención/reinicio normalmente envía **SIGTERM**; compilaciones antiguas pueden mostrarlo como salida `pnpm` `ELIFECYCLE` código **143** (SIGTERM), lo cual es un apagado normal, no un fallo.
- **SIGUSR1** activa un reinicio en proceso cuando está autorizado (aplicación/actualización de herramienta/config del gateway, o habilite `commands.restart` para reinicios manuales).
- La autenticación del Gateway es requerida por defecto: configure `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`) o `gateway.auth.password`. Los clientes deben enviar `connect.params.auth.token/password` a menos que usen la identidad de Tailscale Serve.
- El asistente ahora genera un token por defecto, incluso en loopback.
- Precedencia de puertos: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > predeterminado `18789`.

## Acceso remoto

- Tailscale/VPN es preferido; de lo contrario, túnel SSH:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- Luego los clientes se conectan a `ws://127.0.0.1:18789` a través del túnel.

- Si se configura un token, los clientes deben incluirlo en `connect.params.auth.token` incluso a través del túnel.

## Múltiples gateways (mismo host)

Por lo general es innecesario: un Gateway puede servir múltiples canales de mensajería y agentes. Use múltiples Gateways solo para redundancia o aislamiento estricto (ej.: bot de rescate).

Es compatible si aísla estado + configuración y usa puertos únicos. Guía completa: [Múltiples gateways](/gateway/multiple-gateways).

Los nombres de servicio reconocen perfiles:

- macOS: `bot.molt.<profile>` (el heredado `com.openclaw.*` aún puede existir)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

Los metadatos de instalación están incrustados en la configuración del servicio:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Patrón de Bot de Rescate: mantenga un segundo Gateway aislado con su propio perfil, directorio de estado, espacio de trabajo y separación de puertos base. Guía completa: [Guía de bot de rescate](/gateway/multiple-gateways#rescue-bot-guide).

### Perfil dev (`--dev`)

Ruta rápida: ejecute una instancia de desarrollo totalmente aislada (configuración/estado/espacio de trabajo) sin tocar su configuración principal.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

Valores predeterminados (pueden sobrescribirse vía env/flags/config):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- puerto del servicio de control del navegador = `19003` (derivado: `gateway.port+2`, solo loopback)
- `canvasHost.port=19005` (derivado: `gateway.port+4`)
- `agents.defaults.workspace` por defecto pasa a ser `~/.openclaw/workspace-dev` cuando ejecuta `setup`/`onboard` bajo `--dev`.

Puertos derivados (reglas generales):

- Puerto base = `gateway.port` (o `OPENCLAW_GATEWAY_PORT` / `--port`)
- puerto del servicio de control del navegador = base + 2 (solo loopback)
- `canvasHost.port = base + 4` (o `OPENCLAW_CANVAS_HOST_PORT` / sobrescritura de config)
- Los puertos CDP del perfil del navegador se asignan automáticamente desde `browser.controlPort + 9 .. + 108` (persistidos por perfil).

Lista de verificación por instancia:

- `gateway.port` único
- `OPENCLAW_CONFIG_PATH` único
- `OPENCLAW_STATE_DIR` único
- `agents.defaults.workspace` único
- números de WhatsApp separados (si usa WA)

Instalación del servicio por perfil:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

Ejemplo:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## Protocolo (vista del operador)

- Documentación completa: [Protocolo del Gateway](/gateway/protocol) y [Protocolo Bridge (heredado)](/gateway/bridge-protocol).
- Primer frame obligatorio del cliente: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- El Gateway responde `res {type:"res", id, ok:true, payload:hello-ok }` (o `ok:false` con un error, y luego cierra).
- Después del handshake:
  - Solicitudes: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - Eventos: `{type:"event", event, payload, seq?, stateVersion?}`
- Entradas de presencia estructuradas: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (para clientes WS, `instanceId` proviene de `connect.client.instanceId`).
- Las respuestas `agent` son de dos etapas: primero un ack `res` `{runId,status:"accepted"}`, luego un `res` `{runId,status:"ok"|"error",summary}` final tras finalizar la ejecución; la salida en streaming llega como `event:"agent"`.

## Métodos (conjunto inicial)

- `health` — instantánea completa de salud (misma forma que `openclaw health --json`).
- `status` — resumen corto.
- `system-presence` — lista de presencia actual.
- `system-event` — publicar una nota de presencia/sistema (estructurada).
- `send` — enviar un mensaje vía el/los canal(es) activo(s).
- `agent` — ejecutar un turno de agente (transmite eventos de vuelta por la misma conexión).
- `node.list` — listar nodos emparejados y actualmente conectados (incluye `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` y `commands` anunciados).
- `node.describe` — describir un nodo (capacidades + comandos `node.invoke` soportados; funciona para nodos emparejados y para nodos no emparejados actualmente conectados).
- `node.invoke` — invocar un comando en un nodo (p. ej., `canvas.*`, `camera.*`).
- `node.pair.*` — ciclo de vida de emparejamiento (`request`, `list`, `approve`, `reject`, `verify`).

Vea también: [Presencia](/concepts/presence) para cómo se produce/deduplica la presencia y por qué importa un `client.instanceId` estable.

## Eventos

- `agent` — eventos de herramienta/salida transmitidos desde la ejecución del agente (etiquetados por secuencia).
- `presence` — actualizaciones de presencia (deltas con stateVersion) enviadas a todos los clientes conectados.
- `tick` — keepalive/no-op periódico para confirmar vitalidad.
- `shutdown` — el Gateway está saliendo; la carga incluye `reason` y `restartExpectedMs` opcional. Los clientes deben reconectarse.

## Integración de WebChat

- WebChat es una UI nativa en SwiftUI que habla directamente con el WebSocket del Gateway para historial, envíos, abortar y eventos.
- El uso remoto pasa por el mismo túnel SSH/Tailscale; si se configura un token del gateway, el cliente lo incluye durante `connect`.
- La app de macOS se conecta vía un solo WS (conexión compartida); hidrata la presencia desde la instantánea inicial y escucha eventos `presence` para actualizar la UI.

## Tipado y validación

- El servidor valida cada frame entrante con AJV contra JSON Schema emitido desde las definiciones del protocolo.
- Los clientes (TS/Swift) consumen tipos generados (TS directamente; Swift vía el generador del repositorio).
- Las definiciones del protocolo son la fuente de verdad; regenere esquema/modelos con:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## Instantánea de conexión

- `hello-ok` incluye un `snapshot` con `presence`, `health`, `stateVersion` y `uptimeMs` además de `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` para que los clientes rendericen de inmediato sin solicitudes extra.
- `health`/`system-presence` siguen disponibles para actualización manual, pero no son requeridos al momento de conectar.

## Códigos de error (forma res.error)

- Los errores usan `{ code, message, details?, retryable?, retryAfterMs? }`.
- Códigos estándar:
  - `NOT_LINKED` — WhatsApp no autenticado.
  - `AGENT_TIMEOUT` — el agente no respondió dentro del plazo configurado.
  - `INVALID_REQUEST` — falló la validación de esquema/parámetros.
  - `UNAVAILABLE` — el Gateway se está apagando o una dependencia no está disponible.

## Comportamiento de keepalive

- Se emiten eventos `tick` (o ping/pong de WS) periódicamente para que los clientes sepan que el Gateway está activo incluso cuando no hay tráfico.
- Los acuses de envío/agente permanecen como respuestas separadas; no sobrecargue los ticks para envíos.

## Reproducción / huecos

- Los eventos no se reproducen. Los clientes detectan huecos de secuencia y deben refrescar (`health` + `system-presence`) antes de continuar. WebChat y los clientes de macOS ahora auto-refrescan ante un hueco.

## Supervisión (ejemplo macOS)

- Use launchd para mantener el servicio activo:
  - Programa: ruta a `openclaw`
  - Argumentos: `gateway`
  - KeepAlive: true
  - StandardOut/Err: rutas de archivo o `syslog`
- Ante fallos, launchd reinicia; una mala configuración fatal debe seguir saliendo para que el operador lo note.
- Los LaunchAgents son por usuario y requieren una sesión iniciada; para configuraciones sin cabeza use un LaunchDaemon personalizado (no incluido).
  - `openclaw gateway install` escribe `~/Library/LaunchAgents/bot.molt.gateway.plist`
    (o `bot.molt.<profile>.plist`; el heredado `com.openclaw.*` se limpia).
  - `openclaw doctor` audita la configuración del LaunchAgent y puede actualizarla a los valores predeterminados actuales.

## Gestión del servicio Gateway (CLI)

Use la CLI del Gateway para instalar/iniciar/detener/reiniciar/estado:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

Notas:

- `gateway status` sondea el RPC del Gateway por defecto usando el puerto/config resueltos del servicio (sobrescriba con `--url`).
- `gateway status --deep` agrega escaneos a nivel de sistema (LaunchDaemons/unidades del sistema).
- `gateway status --no-probe` omite el sondeo RPC (útil cuando la red está caída).
- `gateway status --json` es estable para scripts.
- `gateway status` reporta **tiempo de ejecución del supervisor** (launchd/systemd en ejecución) por separado de **alcance RPC** (conexión WS + RPC de estado).
- `gateway status` imprime la ruta de configuración + el objetivo del sondeo para evitar confusión de “localhost vs enlace LAN” y desajustes de perfil.
- `gateway status` incluye la última línea de error del gateway cuando el servicio parece en ejecución pero el puerto está cerrado.
- `logs` hace tail del log de archivo del Gateway vía RPC (no se requiere `tail`/`grep` manual).
- Si se detectan otros servicios tipo gateway, la CLI advierte a menos que sean servicios de perfil OpenClaw.
  Aun así recomendamos **un gateway por máquina** para la mayoría de configuraciones; use perfiles/puertos aislados para redundancia o un bot de rescate. Vea [Múltiples gateways](/gateway/multiple-gateways).
  - Limpieza: `openclaw gateway uninstall` (servicio actual) y `openclaw doctor` (migraciones heredadas).
- `gateway install` no hace nada cuando ya está instalado; use `openclaw gateway install --force` para reinstalar (cambios de perfil/env/ruta).

App mac incluida:

- OpenClaw.app puede empaquetar un relay de gateway basado en Node e instalar un LaunchAgent por usuario etiquetado
  `bot.molt.gateway` (o `bot.molt.<profile>`; las etiquetas heredadas `com.openclaw.*` aún se descargan limpiamente).
- Para detenerlo limpiamente, use `openclaw gateway stop` (o `launchctl bootout gui/$UID/bot.molt.gateway`).
- Para reiniciar, use `openclaw gateway restart` (o `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` solo funciona si el LaunchAgent está instalado; de lo contrario use `openclaw gateway install` primero.
  - Reemplace la etiqueta con `bot.molt.<profile>` al ejecutar un perfil con nombre.

## Supervisión (unidad de usuario systemd)

OpenClaw instala un **servicio de usuario systemd** por defecto en Linux/WSL2. Recomendamos
servicios de usuario para máquinas de un solo usuario (entorno más simple, configuración por usuario).
Use un **servicio del sistema** para servidores multiusuario o siempre activos (no requiere lingering, supervisión compartida).

`openclaw gateway install` escribe la unidad de usuario. `openclaw doctor` audita la
unidad y puede actualizarla para coincidir con los valores predeterminados recomendados actuales.

Cree `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

Habilite lingering (requerido para que el servicio de usuario sobreviva a cierre de sesión/inactividad):

```
sudo loginctl enable-linger youruser
```

El onboarding ejecuta esto en Linux/WSL2 (puede solicitar sudo; escribe `/var/lib/systemd/linger`).
Luego habilite el servicio:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**Alternativa (servicio del sistema)**: para servidores siempre activos o multiusuario, puede
instalar una unidad **del sistema** systemd en lugar de una unidad de usuario (no se requiere lingering).
Cree `/etc/systemd/system/openclaw-gateway[-<profile>].service` (copie la unidad anterior,
cambie `WantedBy=multi-user.target`, establezca `User=` + `WorkingDirectory=`), luego:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Las instalaciones en Windows deben usar **WSL2** y seguir la sección de systemd de Linux anterior.

## Verificaciones operativas

- Vitalidad: abra WS y envíe `req:connect` → espere `res` con `payload.type="hello-ok"` (con instantánea).
- Preparación: llame `health` → espere `ok: true` y un canal vinculado en `linkChannel` (cuando aplique).
- Depuración: suscríbase a los eventos `tick` y `presence`; asegúrese de que `status` muestre la edad de vinculación/autenticación; las entradas de presencia muestran el host del Gateway y los clientes conectados.

## Garantías de seguridad

- Asuma un Gateway por host por defecto; si ejecuta múltiples perfiles, aísle puertos/estado y apunte a la instancia correcta.
- No hay fallback a conexiones directas de Baileys; si el Gateway está caído, los envíos fallan rápido.
- Los primeros frames no-connect o JSON malformado se rechazan y el socket se cierra.
- Apagado ordenado: emite el evento `shutdown` antes de cerrar; los clientes deben manejar cierre + reconexión.

## Ayudantes de la CLI

- `openclaw gateway health|status` — solicitar salud/estado sobre el WS del Gateway.
- `openclaw message send --target <num> --message "hi" [--media ...]` — enviar vía Gateway (idempotente para WhatsApp).
- `openclaw agent --message "hi" --to <num>` — ejecutar un turno de agente (espera el final por defecto).
- `openclaw gateway call <method> --params '{"k":"v"}'` — invocador de método en bruto para depuración.
- `openclaw gateway stop|restart` — detener/reiniciar el servicio del gateway supervisado (launchd/systemd).
- Los subcomandos auxiliares del Gateway asumen un gateway en ejecución en `--url`; ya no generan uno automáticamente.

## Guía de migración

- Retire usos de `openclaw gateway` y del puerto de control TCP heredado.
- Actualice los clientes para hablar el protocolo WS con connect obligatorio y presencia estructurada.
