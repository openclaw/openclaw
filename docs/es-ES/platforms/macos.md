---
summary: "Aplicación complementaria OpenClaw para macOS (barra de menús + broker de gateway)"
read_when:
  - Implementando características de la aplicación macOS
  - Cambiando el ciclo de vida del gateway o el puente de nodos en macOS
title: "Aplicación macOS"
---

# OpenClaw Complementaria para macOS (barra de menús + broker de gateway)

La aplicación macOS es la **complementaria de barra de menús** para OpenClaw. Posee permisos,
gestiona/conecta al Gateway localmente (launchd o manual), y expone
capacidades de macOS al agente como un nodo.

## Qué hace

- Muestra notificaciones nativas y estado en la barra de menús.
- Posee prompts TCC (Notificaciones, Accesibilidad, Grabación de Pantalla, Micrófono,
  Reconocimiento de Voz, Automatización/AppleScript).
- Ejecuta o conecta al Gateway (local o remoto).
- Expone herramientas exclusivas de macOS (Lienzo, Cámara, Grabación de Pantalla, `system.run`).
- Inicia el servicio de host de nodo local en modo **remoto** (launchd), y lo detiene en modo **local**.
- Opcionalmente aloja **PeekabooBridge** para automatización de UI.
- Instala el CLI global (`openclaw`) vía npm/pnpm bajo petición (bun no recomendado para el runtime del Gateway).

## Modo local vs remoto

- **Local** (predeterminado): la aplicación se conecta a un Gateway local en ejecución si está presente;
  de lo contrario habilita el servicio launchd vía `openclaw gateway install`.
- **Remoto**: la aplicación se conecta a un Gateway a través de SSH/Tailscale y nunca inicia
  un proceso local.
  La aplicación inicia el **servicio de host de nodo local** para que el Gateway remoto pueda alcanzar esta Mac.
  La aplicación no genera el Gateway como un proceso hijo.

## Control de Launchd

La aplicación gestiona un LaunchAgent por usuario etiquetado `bot.molt.gateway`
(o `bot.molt.<profile>` cuando se usa `--profile`/`OPENCLAW_PROFILE`; el legado `com.openclaw.*` aún se descarga).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Reemplaza la etiqueta con `bot.molt.<profile>` cuando ejecutes un perfil nombrado.

Si el LaunchAgent no está instalado, habilítalo desde la aplicación o ejecuta
`openclaw gateway install`.

## Capacidades de nodo (mac)

La aplicación macOS se presenta como un nodo. Comandos comunes:

- Lienzo: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Cámara: `camera.snap`, `camera.clip`
- Pantalla: `screen.record`
- Sistema: `system.run`, `system.notify`

El nodo reporta un mapa de `permissions` para que los agentes puedan decidir qué está permitido.

Servicio de nodo + IPC de aplicación:

- Cuando el servicio de host de nodo sin interfaz está en ejecución (modo remoto), se conecta al WS del Gateway como un nodo.
- `system.run` ejecuta en la aplicación macOS (contexto UI/TCC) sobre un socket Unix local; los prompts + salida permanecen en la aplicación.

Diagrama (SCI):

```
Gateway -> Servicio de Nodo (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Aplicación Mac (UI + TCC + system.run)
```

## Aprobaciones de ejecución (system.run)

`system.run` es controlado por **Aprobaciones de ejecución** en la aplicación macOS (Configuración → Aprobaciones de ejecución).
La seguridad + preguntar + lista de permitidos se almacenan localmente en la Mac en:

```
~/.openclaw/exec-approvals.json
```

Ejemplo:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

Notas:

- Las entradas de `allowlist` son patrones glob para rutas binarias resueltas.
- Elegir "Permitir Siempre" en el prompt agrega ese comando a la lista de permitidos.
- Las anulaciones de entorno de `system.run` son filtradas (elimina `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) y luego se fusionan con el entorno de la aplicación.

## Enlaces profundos

La aplicación registra el esquema URL `openclaw://` para acciones locales.

### `openclaw://agent`

Desencadena una solicitud `agent` del Gateway.

```bash
open 'openclaw://agent?message=Hola%20desde%20enlace%20profundo'
```

Parámetros de consulta:

- `message` (requerido)
- `sessionKey` (opcional)
- `thinking` (opcional)
- `deliver` / `to` / `channel` (opcional)
- `timeoutSeconds` (opcional)
- `key` (opcional clave de modo desatendido)

Seguridad:

- Sin `key`, la aplicación solicita confirmación.
- Sin `key`, la aplicación impone un límite corto de mensaje para el prompt de confirmación e ignora `deliver` / `to` / `channel`.
- Con una `key` válida, la ejecución es desatendida (destinada a automatizaciones personales).

## Flujo de incorporación (típico)

1. Instala y lanza **OpenClaw.app**.
2. Completa la lista de verificación de permisos (prompts TCC).
3. Asegúrate de que el modo **Local** esté activo y el Gateway esté ejecutándose.
4. Instala el CLI si deseas acceso desde terminal.

## Flujo de construcción y desarrollo (nativo)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (o Xcode)
- Empaquetar aplicación: `scripts/package-mac-app.sh`

## Depurar conectividad del gateway (CLI macOS)

Usa el CLI de depuración para ejercitar el mismo handshake WebSocket del Gateway y lógica de descubrimiento
que usa la aplicación macOS, sin lanzar la aplicación.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Opciones de conexión:

- `--url <ws://host:port>`: anular config
- `--mode <local|remote>`: resolver desde config (predeterminado: config o local)
- `--probe`: forzar una sonda de salud fresca
- `--timeout <ms>`: timeout de solicitud (predeterminado: `15000`)
- `--json`: salida estructurada para diferencias

Opciones de descubrimiento:

- `--include-local`: incluir gateways que serían filtrados como "locales"
- `--timeout <ms>`: ventana de descubrimiento general (predeterminado: `2000`)
- `--json`: salida estructurada para diferencias

Consejo: compara contra `openclaw gateway discover --json` para ver si el
pipeline de descubrimiento de la aplicación macOS (NWBrowser + respaldo DNS‑SD de tailnet) difiere del
descubrimiento basado en `dns-sd` del CLI de Node.

## Plomería de conexión remota (túneles SSH)

Cuando la aplicación macOS se ejecuta en modo **Remoto**, abre un túnel SSH para que los
componentes locales de UI puedan hablar con un Gateway remoto como si estuviera en localhost.

### Túnel de control (puerto WebSocket del Gateway)

- **Propósito:** verificaciones de salud, estado, Web Chat, config y otras llamadas del plano de control.
- **Puerto local:** el puerto del Gateway (predeterminado `18789`), siempre estable.
- **Puerto remoto:** el mismo puerto del Gateway en el host remoto.
- **Comportamiento:** sin puerto local aleatorio; la aplicación reutiliza un túnel saludable existente
  o lo reinicia si es necesario.
- **Forma SSH:** `ssh -N -L <local>:127.0.0.1:<remote>` con BatchMode +
  ExitOnForwardFailure + opciones de keepalive.
- **Reporte de IP:** el túnel SSH usa loopback, por lo que el gateway verá la IP del nodo
  como `127.0.0.1`. Usa transporte **Directo (ws/wss)** si quieres que aparezca la IP real del cliente
  (ver [acceso remoto macOS](/es-ES/platforms/mac/remote)).

Para pasos de configuración, ver [acceso remoto macOS](/es-ES/platforms/mac/remote). Para detalles
de protocolo, ver [protocolo del Gateway](/es-ES/gateway/protocol).

## Documentación relacionada

- [Manual del Gateway](/es-ES/gateway)
- [Gateway (macOS)](/es-ES/platforms/mac/bundled-gateway)
- [Permisos macOS](/es-ES/platforms/mac/permissions)
- [Lienzo](/es-ES/platforms/mac/canvas)
