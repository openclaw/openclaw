---
summary: "CLI del Gateway de OpenClaw (`openclaw gateway`) — ejecutar, consultar y descubrir gateways"
read_when:
  - Ejecución del Gateway desde la CLI (desarrollo o servidores)
  - Depuración de autenticación del Gateway, modos de enlace y conectividad
  - Descubrimiento de gateways mediante Bonjour (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

El Gateway es el servidor WebSocket de OpenClaw (canales, nodos, sesiones, hooks).

Los subcomandos de esta página viven bajo `openclaw gateway …`.

Documentación relacionada:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Ejecutar el Gateway

Ejecute un proceso local del Gateway:

```bash
openclaw gateway
```

Alias de primer plano:

```bash
openclaw gateway run
```

Notas:

- De forma predeterminada, el Gateway se niega a iniciar a menos que `gateway.mode=local` esté configurado en `~/.openclaw/openclaw.json`. Use `--allow-unconfigured` para ejecuciones ad‑hoc/de desarrollo.
- El enlace más allá de loopback sin autenticación está bloqueado (barrera de seguridad).
- `SIGUSR1` activa un reinicio en proceso cuando está autorizado (habilite `commands.restart` o use la herramienta/configuración de gateway aplicar/actualizar).
- Los manejadores `SIGINT`/`SIGTERM` detienen el proceso del gateway, pero no restauran ningún estado personalizado del terminal. Si envuelve la CLI con una TUI o entrada en modo raw, restaure el terminal antes de salir.

### Opciones

- `--port <port>`: puerto WebSocket (el valor predeterminado proviene de la configuración/variables de entorno; normalmente `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: modo de enlace del listener.
- `--auth <token|password>`: anulación del modo de autenticación.
- `--token <token>`: anulación del token (también establece `OPENCLAW_GATEWAY_TOKEN` para el proceso).
- `--password <password>`: anulación de contraseña (también establece `OPENCLAW_GATEWAY_PASSWORD` para el proceso).
- `--tailscale <off|serve|funnel>`: exponer el Gateway mediante Tailscale.
- `--tailscale-reset-on-exit`: restablecer la configuración de serve/funnel de Tailscale al apagarse.
- `--allow-unconfigured`: permitir iniciar el gateway sin `gateway.mode=local` en la configuración.
- `--dev`: crear una configuración de desarrollo + espacio de trabajo si falta (omite BOOTSTRAP.md).
- `--reset`: restablecer configuración de desarrollo + credenciales + sesiones + espacio de trabajo (requiere `--dev`).
- `--force`: finalizar cualquier listener existente en el puerto seleccionado antes de iniciar.
- `--verbose`: registros verbosos.
- `--claude-cli-logs`: mostrar solo los registros de claude-cli en la consola (y habilitar su stdout/stderr).
- `--ws-log <auto|full|compact>`: estilo de registro de websocket (predeterminado `auto`).
- `--compact`: alias de `--ws-log compact`.
- `--raw-stream`: registrar eventos de streaming crudo del modelo en jsonl.
- `--raw-stream-path <path>`: ruta del jsonl de streaming crudo.

## Consultar un Gateway en ejecución

Todos los comandos de consulta usan RPC por WebSocket.

Modos de salida:

- Predeterminado: legible para humanos (con color en TTY).
- `--json`: JSON legible por máquina (sin estilo/spinner).
- `--no-color` (o `NO_COLOR=1`): deshabilitar ANSI manteniendo el diseño humano.

Opciones compartidas (donde se admiten):

- `--url <url>`: URL WebSocket del Gateway.
- `--token <token>`: token del Gateway.
- `--password <password>`: contraseña del Gateway.
- `--timeout <ms>`: tiempo de espera/presupuesto (varía según el comando).
- `--expect-final`: esperar una respuesta “final” (llamadas de agente).

Nota: cuando configura `--url`, la CLI no recurre a credenciales de configuración ni de entorno.
Pase `--token` o `--password` explícitamente. La ausencia de credenciales explícitas es un error.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` muestra el servicio del Gateway (launchd/systemd/schtasks) además de una sonda RPC opcional.

```bash
openclaw gateway status
openclaw gateway status --json
```

Opciones:

- `--url <url>`: anular la URL de la sonda.
- `--token <token>`: autenticación por token para la sonda.
- `--password <password>`: autenticación por contraseña para la sonda.
- `--timeout <ms>`: tiempo de espera de la sonda (predeterminado `10000`).
- `--no-probe`: omitir la sonda RPC (vista solo del servicio).
- `--deep`: escanear también servicios a nivel del sistema.

### `gateway probe`

`gateway probe` es el comando de “depurar todo”. Siempre sondea:

- su gateway remoto configurado (si está configurado), y
- localhost (loopback) **incluso si hay un remoto configurado**.

Si hay varios gateways alcanzables, los imprime todos. Se admiten múltiples gateways cuando usa perfiles/puertos aislados (por ejemplo, un bot de rescate), pero la mayoría de las instalaciones aún ejecutan un solo gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Remoto por SSH (paridad con la app de Mac)

El modo “Remote over SSH” de la app de macOS usa un reenvío de puerto local para que el gateway remoto (que puede estar enlazado solo a loopback) sea accesible en `ws://127.0.0.1:<port>`.

Equivalente en la CLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Opciones:

- `--ssh <target>`: `user@host` o `user@host:port` (el puerto predeterminado es `22`).
- `--ssh-identity <path>`: archivo de identidad.
- `--ssh-auto`: elegir el primer host del gateway descubierto como destino SSH (solo LAN/WAB).

Configuración (opcional, usada como valores predeterminados):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Ayudante RPC de bajo nivel.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Administrar el servicio del Gateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Notas:

- `gateway install` admite `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Los comandos de ciclo de vida aceptan `--json` para scripting.

## Descubrir gateways (Bonjour)

`gateway discover` escanea balizas del Gateway (`_openclaw-gw._tcp`).

- DNS-SD multicast: `local.`
- DNS-SD unicast (Wide-Area Bonjour): elija un dominio (ejemplo: `openclaw.internal.`) y configure DNS dividido + un servidor DNS; vea [/gateway/bonjour](/gateway/bonjour)

Solo los gateways con el descubrimiento Bonjour habilitado (predeterminado) anuncian la baliza.

Los registros de descubrimiento Wide-Area incluyen (TXT):

- `role` (pista del rol del gateway)
- `transport` (pista de transporte, p. ej., `gateway`)
- `gatewayPort` (puerto WebSocket, normalmente `18789`)
- `sshPort` (puerto SSH; predeterminado `22` si no está presente)
- `tailnetDns` (nombre de host MagicDNS, cuando está disponible)
- `gatewayTls` / `gatewayTlsSha256` (TLS habilitado + huella del certificado)
- `cliPath` (pista opcional para instalaciones remotas)

### `gateway discover`

```bash
openclaw gateway discover
```

Opciones:

- `--timeout <ms>`: tiempo de espera por comando (navegar/resolver); predeterminado `2000`.
- `--json`: salida legible por máquina (también deshabilita estilo/spinner).

Ejemplos:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
