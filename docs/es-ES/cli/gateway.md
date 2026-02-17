---
summary: "CLI del Gateway de OpenClaw (`openclaw gateway`) — ejecutar, consultar y descubrir gateways"
read_when:
  - Ejecutar el Gateway desde el CLI (dev o servidores)
  - Depurar autenticación, modos de bind y conectividad del Gateway
  - Descubrir gateways a través de Bonjour (LAN + tailnet)
title: "gateway"
---

# CLI del Gateway

El Gateway es el servidor WebSocket de OpenClaw (canales, nodos, sesiones, hooks).

Los subcomandos en esta página viven bajo `openclaw gateway …`.

Documentos relacionados:

- [/gateway/bonjour](/es-ES/gateway/bonjour)
- [/gateway/discovery](/es-ES/gateway/discovery)
- [/gateway/configuration](/es-ES/gateway/configuration)

## Ejecutar el Gateway

Ejecutar un proceso Gateway local:

```bash
openclaw gateway
```

Alias de primer plano:

```bash
openclaw gateway run
```

Notas:

- Por defecto, el Gateway se niega a iniciar a menos que `gateway.mode=local` esté establecido en `~/.openclaw/openclaw.json`. Usa `--allow-unconfigured` para ejecuciones ad-hoc/dev.
- El binding más allá de loopback sin autenticación está bloqueado (protección de seguridad).
- `SIGUSR1` dispara un reinicio en proceso cuando está autorizado (habilitar `commands.restart` o usar la herramienta gateway/aplicar configuración/actualizar).
- Los manejadores `SIGINT`/`SIGTERM` detienen el proceso del gateway, pero no restauran ningún estado de terminal personalizado. Si envuelves el CLI con una TUI o entrada en modo raw, restaura el terminal antes de salir.

### Opciones

- `--port <port>`: puerto WebSocket (el predeterminado viene de configuración/env; usualmente `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: modo de bind del oyente.
- `--auth <token|password>`: sobrescritura de modo de autenticación.
- `--token <token>`: sobrescritura de token (también establece `OPENCLAW_GATEWAY_TOKEN` para el proceso).
- `--password <password>`: sobrescritura de contraseña (también establece `OPENCLAW_GATEWAY_PASSWORD` para el proceso).
- `--tailscale <off|serve|funnel>`: exponer el Gateway a través de Tailscale.
- `--tailscale-reset-on-exit`: restablecer configuración serve/funnel de Tailscale al apagar.
- `--allow-unconfigured`: permitir inicio del gateway sin `gateway.mode=local` en configuración.
- `--dev`: crear una configuración dev + espacio de trabajo si falta (omite BOOTSTRAP.md).
- `--reset`: restablecer configuración dev + credenciales + sesiones + espacio de trabajo (requiere `--dev`).
- `--force`: matar cualquier oyente existente en el puerto seleccionado antes de iniciar.
- `--verbose`: registros verbosos.
- `--claude-cli-logs`: solo mostrar registros de claude-cli en la consola (y habilitar su stdout/stderr).
- `--ws-log <auto|full|compact>`: estilo de registro websocket (predeterminado `auto`).
- `--compact`: alias para `--ws-log compact`.
- `--raw-stream`: registrar eventos de flujo de modelo sin formato a jsonl.
- `--raw-stream-path <path>`: ruta jsonl de flujo sin formato.

## Consultar un Gateway en ejecución

Todos los comandos de consulta usan RPC WebSocket.

Modos de salida:

- Predeterminado: legible para humanos (coloreado en TTY).
- `--json`: JSON legible por máquina (sin estilo/spinner).
- `--no-color` (o `NO_COLOR=1`): desactivar ANSI mientras se mantiene el diseño humano.

Opciones compartidas (donde esté soportado):

- `--url <url>`: URL WebSocket del Gateway.
- `--token <token>`: token del Gateway.
- `--password <password>`: contraseña del Gateway.
- `--timeout <ms>`: tiempo de espera/presupuesto (varía por comando).
- `--expect-final`: esperar una respuesta "final" (llamadas de agente).

Nota: cuando estableces `--url`, el CLI no vuelve a las credenciales de configuración o entorno.
Pasa `--token` o `--password` explícitamente. Faltar credenciales explícitas es un error.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` muestra el servicio Gateway (launchd/systemd/schtasks) más una sonda RPC opcional.

```bash
openclaw gateway status
openclaw gateway status --json
```

Opciones:

- `--url <url>`: sobrescribir la URL de sonda.
- `--token <token>`: autenticación de token para la sonda.
- `--password <password>`: autenticación de contraseña para la sonda.
- `--timeout <ms>`: tiempo de espera de sonda (predeterminado `10000`).
- `--no-probe`: omitir la sonda RPC (vista solo de servicio).
- `--deep`: escanear servicios a nivel de sistema también.

### `gateway probe`

`gateway probe` es el comando de "depurar todo". Siempre sondea:

- tu gateway remoto configurado (si está establecido), y
- localhost (loopback) **incluso si el remoto está configurado**.

Si múltiples gateways son alcanzables, los imprime todos. Múltiples gateways están soportados cuando usas perfiles/puertos aislados (ej., un bot de rescate), pero la mayoría de las instalaciones todavía ejecutan un solo gateway.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### Remoto sobre SSH (paridad con app de Mac)

El modo "Remoto sobre SSH" de la app de macOS usa un port-forward local para que el gateway remoto (que puede estar vinculado solo a loopback) se vuelva alcanzable en `ws://127.0.0.1:<port>`.

Equivalente CLI:

```bash
openclaw gateway probe --ssh user@gateway-host
```

Opciones:

- `--ssh <target>`: `user@host` o `user@host:port` (el puerto por defecto es `22`).
- `--ssh-identity <path>`: archivo de identidad.
- `--ssh-auto`: elegir el primer host de gateway descubierto como objetivo SSH (solo LAN/WAB).

Configuración (opcional, usada como predeterminados):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Ayudante RPC de bajo nivel.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gestionar el servicio Gateway

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

Notas:

- `gateway install` soporta `--port`, `--runtime`, `--token`, `--force`, `--json`.
- Los comandos de ciclo de vida aceptan `--json` para scripting.

## Descubrir gateways (Bonjour)

`gateway discover` escanea en busca de balizas de Gateway (`_openclaw-gw._tcp`).

- DNS-SD multicast: `local.`
- DNS-SD unicast (Wide-Area Bonjour): elige un dominio (ejemplo: `openclaw.internal.`) y configura DNS dividido + un servidor DNS; ver [/gateway/bonjour](/es-ES/gateway/bonjour)

Solo los gateways con descubrimiento Bonjour habilitado (predeterminado) anuncian la baliza.

Los registros de descubrimiento de área amplia incluyen (TXT):

- `role` (pista de rol del gateway)
- `transport` (pista de transporte, ej. `gateway`)
- `gatewayPort` (puerto WebSocket, usualmente `18789`)
- `sshPort` (puerto SSH; por defecto `22` si no está presente)
- `tailnetDns` (nombre de host MagicDNS, cuando esté disponible)
- `gatewayTls` / `gatewayTlsSha256` (TLS habilitado + huella de certificado)
- `cliPath` (pista opcional para instalaciones remotas)

### `gateway discover`

```bash
openclaw gateway discover
```

Opciones:

- `--timeout <ms>`: tiempo de espera por comando (browse/resolve); predeterminado `2000`.
- `--json`: salida legible por máquina (también desactiva estilo/spinner).

Ejemplos:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
