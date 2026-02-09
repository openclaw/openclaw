---
summary: "UI de control basada en navegador para el Gateway (chat, nodos, configuración)"
read_when:
  - Quiere operar el Gateway desde un navegador
  - Quiere acceso a Tailnet sin túneles SSH
title: "UI de control"
---

# UI de control (navegador)

La UI de control es una pequeña aplicación de una sola página **Vite + Lit** servida por el Gateway:

- predeterminado: `http://<host>:18789/`
- prefijo opcional: configure `gateway.controlUi.basePath` (p. ej., `/openclaw`)

Se comunica **directamente con el WebSocket del Gateway** en el mismo puerto.

## Apertura rápida (local)

Si el Gateway se está ejecutando en la misma computadora, abra:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (o [http://localhost:18789/](http://localhost:18789/))

Si la página no carga, inicie primero el Gateway: `openclaw gateway`.

La autenticación se proporciona durante el handshake de WebSocket mediante:

- `connect.params.auth.token`
- `connect.params.auth.password`
  El panel de configuración del dashboard le permite almacenar un token; las contraseñas no se persisten.
  El asistente de incorporación genera un token del gateway de forma predeterminada, así que péguelo aquí en la primera conexión.

## Emparejamiento de dispositivos (primera conexión)

Cuando se conecta a la UI de control desde un navegador o dispositivo nuevo, el Gateway
requiere una **aprobación de emparejamiento única** — incluso si está en la misma Tailnet
con `gateway.auth.allowTailscale: true`. Esto es una medida de seguridad para prevenir
accesos no autorizados.

**Lo que verá:** "disconnected (1008): pairing required"

**Para aprobar el dispositivo:**

```bash
# List pending requests
openclaw devices list

# Approve by request ID
openclaw devices approve <requestId>
```

Una vez aprobado, el dispositivo se recuerda y no requerirá re-aprobación a menos que
lo revoque con `openclaw devices revoke --device <id> --role <role>`. Consulte
[Devices CLI](/cli/devices) para rotación y revocación de tokens.

**Notas:**

- Las conexiones locales (`127.0.0.1`) se aprueban automáticamente.
- Las conexiones remotas (LAN, Tailnet, etc.) requieren aprobación explícita.
- Cada perfil de navegador genera un ID de dispositivo único, por lo que cambiar de navegador o
  borrar los datos del navegador requerirá volver a emparejar.

## Qué puede hacer (hoy)

- Chatear con el modelo vía Gateway WS (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Transmitir llamadas a herramientas + tarjetas de salida de herramientas en vivo en Chat (eventos del agente)
- Canales: estado de WhatsApp/Telegram/Discord/Slack + canales de plugins (Mattermost, etc.) + inicio de sesión por QR + configuración por canal (`channels.status`, `web.login.*`, `config.patch`)
- Instancias: lista de presencia + actualización (`system-presence`)
- Sesiones: lista + sobrescrituras de thinking/verbose por sesión (`sessions.list`, `sessions.patch`)
- Tareas cron: listar/agregar/ejecutar/habilitar/deshabilitar + historial de ejecuciones (`cron.*`)
- Skills: estado, habilitar/deshabilitar, instalar, actualizaciones de claves de API (`skills.*`)
- Nodos: lista + capacidades (`node.list`)
- Aprobaciones de ejecución: editar listas de permitidos del gateway o del nodo + política de solicitud para `exec host=gateway/node` (`exec.approvals.*`)
- Configuración: ver/editar `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Configuración: aplicar + reiniciar con validación (`config.apply`) y reactivar la última sesión activa
- Las escrituras de configuración incluyen una protección de hash base para evitar sobrescribir ediciones concurrentes
- Esquema de configuración + renderizado de formularios (`config.schema`, incluidos esquemas de plugins + canales); el editor de JSON en bruto sigue disponible
- Depuración: instantáneas de estado/salud/modelos + registro de eventos + llamadas RPC manuales (`status`, `health`, `models.list`)
- Registros: tail en vivo de los registros de archivos del gateway con filtro/exportación (`logs.tail`)
- Actualización: ejecutar una actualización de paquetes/git + reiniciar (`update.run`) con un informe de reinicio

Notas del panel de tareas cron:

- Para tareas aisladas, la entrega predeterminada es anunciar un resumen. Puede cambiar a ninguno si desea ejecuciones solo internas.
- Los campos de canal/destino aparecen cuando se selecciona anunciar.

## Comportamiento del chat

- `chat.send` es **no bloqueante**: confirma de inmediato con `{ runId, status: "started" }` y la respuesta se transmite mediante eventos `chat`.
- Reenviar con el mismo `idempotencyKey` devuelve `{ status: "in_flight" }` mientras se ejecuta, y `{ status: "ok" }` tras la finalización.
- `chat.inject` agrega una nota del asistente al transcript de la sesión y difunde un evento `chat` para actualizaciones solo de la UI (sin ejecución del agente, sin entrega a canales).
- Detener:
  - Haga clic en **Stop** (llama a `chat.abort`)
  - Escriba `/stop` (o `stop|esc|abort|wait|exit|interrupt`) para abortar fuera de banda
  - `chat.abort` admite `{ sessionKey }` (sin `runId`) para abortar todas las ejecuciones activas de esa sesión

## Acceso por Tailnet (recomendado)

### Tailscale Serve integrado (preferido)

Mantenga el Gateway en loopback y deje que Tailscale Serve lo proxifique con HTTPS:

```bash
openclaw gateway --tailscale serve
```

Abra:

- `https://<magicdns>/` (o su `gateway.controlUi.basePath` configurado)

De forma predeterminada, las solicitudes de Serve pueden autenticarse mediante encabezados de identidad de Tailscale
(`tailscale-user-login`) cuando `gateway.auth.allowTailscale` es `true`. OpenClaw
verifica la identidad resolviendo la dirección `x-forwarded-for` con
`tailscale whois` y comparándola con el encabezado, y solo acepta estas cuando la
solicitud llega a loopback con los encabezados `x-forwarded-*` de Tailscale. Configure
`gateway.auth.allowTailscale: false` (o fuerce `gateway.auth.mode: "password"`)
si desea requerir un token/contraseña incluso para tráfico de Serve.

### Vincular a tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Luego abra:

- `http://<tailscale-ip>:18789/` (o su `gateway.controlUi.basePath` configurado)

Pegue el token en la configuración de la UI (enviado como `connect.params.auth.token`).

## HTTP inseguro

Si abre el dashboard sobre HTTP sin cifrar (`http://<lan-ip>` o `http://<tailscale-ip>`),
el navegador se ejecuta en un **contexto no seguro** y bloquea WebCrypto. De forma predeterminada,
OpenClaw **bloquea** las conexiones de la UI de control sin identidad de dispositivo.

**Solución recomendada:** use HTTPS (Tailscale Serve) o abra la UI localmente:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (en el host del Gateway)

**Ejemplo de degradación (solo token sobre HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "replace-me" },
  },
}
```

Esto deshabilita la identidad de dispositivo + el emparejamiento para la UI de control (incluso en HTTPS). Úselo
solo si confía en la red.

Consulte [Tailscale](/gateway/tailscale) para obtener orientación sobre la configuración de HTTPS.

## Construcción de la UI

El Gateway sirve archivos estáticos desde `dist/control-ui`. Compílelos con:

```bash
pnpm ui:build # auto-installs UI deps on first run
```

Base absoluta opcional (cuando desea URL de recursos fijas):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Para desarrollo local (servidor de desarrollo separado):

```bash
pnpm ui:dev # auto-installs UI deps on first run
```

Luego apunte la UI a la URL de WS de su Gateway (p. ej., `ws://127.0.0.1:18789`).

## Depuración/pruebas: servidor de desarrollo + Gateway remoto

La UI de control son archivos estáticos; el destino de WebSocket es configurable y puede ser
diferente del origen HTTP. Esto es útil cuando desea el servidor de desarrollo de Vite
localmente pero el Gateway se ejecuta en otro lugar.

1. Inicie el servidor de desarrollo de la UI: `pnpm ui:dev`
2. Abra una URL como:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Autenticación única opcional (si es necesaria):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notas:

- `gatewayUrl` se almacena en localStorage después de la carga y se elimina de la URL.
- `token` se almacena en localStorage; `password` se mantiene solo en memoria.
- Cuando `gatewayUrl` está configurado, la UI no recurre a credenciales de configuración o de entorno.
  Proporcione `token` (o `password`) explícitamente. La falta de credenciales explícitas es un error.
- Use `wss://` cuando el Gateway esté detrás de TLS (Tailscale Serve, proxy HTTPS, etc.).
- `gatewayUrl` solo se acepta en una ventana de nivel superior (no incrustada) para prevenir clickjacking.
- Para configuraciones de desarrollo de origen cruzado (p. ej., `pnpm ui:dev` hacia un Gateway remoto), agregue el
  origen de la UI a `gateway.controlUi.allowedOrigins`.

Ejemplo:

```json5
{
  gateway: {
    controlUi: {
      allowedOrigins: ["http://localhost:5173"],
    },
  },
}
```

Detalles de configuración de acceso remoto: [Acceso remoto](/gateway/remote).
