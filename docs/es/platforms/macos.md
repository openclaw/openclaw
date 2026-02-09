---
summary: "Aplicación complementaria de OpenClaw para macOS (barra de menú + broker del Gateway)"
read_when:
  - Implementación de funciones de la app para macOS
  - Cambios en el ciclo de vida del Gateway o el puenteo de nodos en macOS
title: "App de macOS"
---

# OpenClaw macOS Companion (barra de menú + broker del Gateway)

La app de macOS es la **aplicación complementaria de la barra de menú** para OpenClaw. Gestiona permisos,
administra/se adjunta al Gateway de forma local (launchd o manual) y expone
capacidades de macOS al agente como un nodo.

## Qué hace

- Muestra notificaciones nativas y estado en la barra de menú.
- Gestiona solicitudes TCC (Notificaciones, Accesibilidad, Grabación de Pantalla, Micrófono,
  Reconocimiento de Voz, Automatización/AppleScript).
- Ejecuta o se conecta al Gateway (local o remoto).
- Expone herramientas exclusivas de macOS (Canvas, Cámara, Grabación de Pantalla, `system.run`).
- Inicia el servicio local de host de nodo en modo **remoto** (launchd) y lo detiene en modo **local**.
- Opcionalmente aloja **PeekabooBridge** para automatización de UI.
- Instala la CLI global (`openclaw`) vía npm/pnpm bajo solicitud (bun no se recomienda para el runtime del Gateway).

## Modo local vs remoto

- **Local** (predeterminado): la app se adjunta a un Gateway local en ejecución si existe;
  de lo contrario habilita el servicio launchd mediante `openclaw gateway install`.
- **Remoto**: la app se conecta a un Gateway por SSH/Tailscale y nunca inicia
  un proceso local.
  La app inicia el **servicio de host de nodo** local para que el Gateway remoto pueda alcanzar este Mac.
  La app no crea el Gateway como proceso hijo.

## Control de Launchd

La app administra un LaunchAgent por usuario etiquetado `bot.molt.gateway`
(o `bot.molt.<profile>` cuando se usa `--profile`/`OPENCLAW_PROFILE`; el legado `com.openclaw.*` aún se descarga).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Reemplace la etiqueta por `bot.molt.<profile>` cuando ejecute un perfil con nombre.

Si el LaunchAgent no está instalado, habilítelo desde la app o ejecute
`openclaw gateway install`.

## Capacidades del nodo (mac)

La app de macOS se presenta como un nodo. Comandos comunes:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Cámara: `camera.snap`, `camera.clip`
- Pantalla: `screen.record`
- Sistema: `system.run`, `system.notify`

El nodo reporta un mapa `permissions` para que los agentes decidan qué está permitido.

Servicio del nodo + IPC de la app:

- Cuando el servicio de host de nodo sin interfaz está en ejecución (modo remoto), se conecta al WS del Gateway como un nodo.
- `system.run` se ejecuta en la app de macOS (contexto de UI/TCC) a través de un socket Unix local; las solicitudes y la salida permanecen dentro de la app.

Diagrama (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Aprobaciones de ejecución (system.run)

`system.run` está controlado por **Aprobaciones de ejecución** en la app de macOS (Ajustes → Aprobaciones de ejecución).
La seguridad + confirmación + lista de permitidos se almacenan localmente en el Mac en:

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

- Las entradas `allowlist` son patrones glob para rutas de binarios resueltas.
- Elegir “Permitir siempre” en la solicitud agrega ese comando a la lista de permitidos.
- Las anulaciones de entorno `system.run` se filtran (se descartan `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) y luego se combinan con el entorno de la app.

## Enlaces profundos

La app registra el esquema de URL `openclaw://` para acciones locales.

### `openclaw://agent`

Dispara una solicitud `agent` del Gateway.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

Parámetros de consulta:

- `message` (requerido)
- `sessionKey` (opcional)
- `thinking` (opcional)
- `deliver` / `to` / `channel` (opcional)
- `timeoutSeconds` (opcional)
- `key` (clave opcional de modo desatendido)

Seguridad:

- Sin `key`, la app solicita confirmación.
- Con un `key` válido, la ejecución es desatendida (pensada para automatizaciones personales).

## Flujo de incorporación (típico)

1. Instale y abra **OpenClaw.app**.
2. Complete la lista de verificación de permisos (solicitudes TCC).
3. Asegúrese de que el modo **Local** esté activo y que el Gateway esté en ejecución.
4. Instale la CLI si desea acceso desde la terminal.

## Flujo de compilación y desarrollo (nativo)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (o Xcode)
- Empaquetar la app: `scripts/package-mac-app.sh`

## Depurar conectividad del Gateway (CLI de macOS)

Use la CLI de depuración para ejercitar el mismo saludo de WebSocket del Gateway y la lógica
de descubrimiento que usa la app de macOS, sin iniciar la app.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

Opciones de conexión:

- `--url <ws://host:port>`: sobrescribir configuración
- `--mode <local|remote>`: resolver desde la configuración (predeterminado: configuración o local)
- `--probe`: forzar una nueva sonda de salud
- `--timeout <ms>`: tiempo de espera de la solicitud (predeterminado: `15000`)
- `--json`: salida estructurada para comparar diferencias

Opciones de descubrimiento:

- `--include-local`: incluir gateways que se filtrarían como “locales”
- `--timeout <ms>`: ventana general de descubrimiento (predeterminado: `2000`)
- `--json`: salida estructurada para comparar diferencias

Consejo: compare con `openclaw gateway discover --json` para ver si el
pipeline de descubrimiento de la app de macOS (NWBrowser + fallback DNS‑SD de tailnet) difiere del descubrimiento basado en `dns-sd` de la CLI de Node.

## Plomería de conexión remota (túneles SSH)

Cuando la app de macOS se ejecuta en modo **Remoto**, abre un túnel SSH para que los componentes
de UI locales puedan comunicarse con un Gateway remoto como si estuviera en localhost.

### Túnel de control (puerto WebSocket del Gateway)

- **Propósito:** comprobaciones de salud, estado, Web Chat, configuración y otras llamadas del plano de control.
- **Puerto local:** el puerto del Gateway (predeterminado `18789`), siempre estable.
- **Puerto remoto:** el mismo puerto del Gateway en el host remoto.
- **Comportamiento:** sin puerto local aleatorio; la app reutiliza un túnel saludable existente
  o lo reinicia si es necesario.
- **Forma de SSH:** `ssh -N -L <local>:127.0.0.1:<remote>` con BatchMode +
  ExitOnForwardFailure + opciones de keepalive.
- **Reporte de IP:** el túnel SSH usa loopback, por lo que el gateway verá la IP del nodo
  como `127.0.0.1`. Use el transporte **Direct (ws/wss)** si desea que aparezca la IP real del cliente (consulte [acceso remoto en macOS](/platforms/mac/remote)).

Para los pasos de configuración, consulte [acceso remoto en macOS](/platforms/mac/remote). Para detalles del protocolo, consulte [protocolo del Gateway](/gateway/protocol).

## Documentos relacionados

- [Runbook del Gateway](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [Permisos de macOS](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
