---
summary: "Interfaz de control basada en navegador para el Gateway (chat, nodos, configuración)"
read_when:
  - Quieres operar el Gateway desde un navegador
  - Quieres acceso a Tailnet sin túneles SSH
title: "Interfaz de Control"
---

# Interfaz de Control (navegador)

La Interfaz de Control es una pequeña aplicación de una sola página **Vite + Lit** servida por el Gateway:

- predeterminado: `http://<host>:18789/`
- prefijo opcional: establece `gateway.controlUi.basePath` (por ejemplo, `/openclaw`)

Habla **directamente con el WebSocket del Gateway** en el mismo puerto.

## Apertura rápida (local)

Si el Gateway está ejecutándose en la misma computadora, abre:

- [http://127.0.0.1:18789/](http://127.0.0.1:18789/) (o [http://localhost:18789/](http://localhost:18789/))

Si la página no se carga, inicia primero el Gateway: `openclaw gateway`.

La autenticación se proporciona durante el handshake del WebSocket mediante:

- `connect.params.auth.token`
- `connect.params.auth.password`
  El panel de configuración del panel de control te permite almacenar un token; las contraseñas no se persisten.
  El asistente de incorporación genera un token del gateway por defecto, así que pégalo aquí en la primera conexión.

## Emparejamiento de dispositivos (primera conexión)

Cuando te conectas a la Interfaz de Control desde un nuevo navegador o dispositivo, el Gateway
requiere una **aprobación de emparejamiento única** — incluso si estás en la misma Tailnet
con `gateway.auth.allowTailscale: true`. Esta es una medida de seguridad para prevenir
acceso no autorizado.

**Lo que verás:** "disconnected (1008): pairing required"

**Para aprobar el dispositivo:**

```bash
# Listar solicitudes pendientes
openclaw devices list

# Aprobar por ID de solicitud
openclaw devices approve <requestId>
```

Una vez aprobado, el dispositivo se recuerda y no requerirá una nueva aprobación a menos que
lo revoques con `openclaw devices revoke --device <id> --role <role>`. Consulta
[CLI de dispositivos](/es-ES/cli/devices) para rotación y revocación de tokens.

**Notas:**

- Las conexiones locales (`127.0.0.1`) se aprueban automáticamente.
- Las conexiones remotas (LAN, Tailnet, etc.) requieren aprobación explícita.
- Cada perfil de navegador genera un ID de dispositivo único, por lo que cambiar de navegador o
  borrar los datos del navegador requerirá un nuevo emparejamiento.

## Lo que puede hacer (hoy)

- Chat con el modelo a través del WS del Gateway (`chat.history`, `chat.send`, `chat.abort`, `chat.inject`)
- Transmisión de llamadas a herramientas + tarjetas de salida de herramientas en vivo en Chat (eventos de agente)
- Canales: estado de WhatsApp/Telegram/Discord/Slack + canales de plugin (Mattermost, etc.) + inicio de sesión QR + configuración por canal (`channels.status`, `web.login.*`, `config.patch`)
- Instancias: lista de presencia + actualización (`system-presence`)
- Sesiones: lista + anulaciones de pensamiento/verboso por sesión (`sessions.list`, `sessions.patch`)
- Tareas programadas: listar/agregar/ejecutar/habilitar/deshabilitar + historial de ejecución (`cron.*`)
- Habilidades: estado, habilitar/deshabilitar, instalar, actualizaciones de claves de API (`skills.*`)
- Nodos: lista + capacidades (`node.list`)
- Aprobaciones de ejecución: editar listas de permisos del gateway o nodo + política de solicitud para `exec host=gateway/node` (`exec.approvals.*`)
- Config: ver/editar `~/.openclaw/openclaw.json` (`config.get`, `config.set`)
- Config: aplicar + reiniciar con validación (`config.apply`) y despertar la última sesión activa
- Las escrituras de configuración incluyen un guardia de hash base para prevenir sobrescritura de ediciones concurrentes
- Esquema de configuración + representación de formularios (`config.schema`, incluyendo esquemas de plugin + canal); el editor JSON sin procesar permanece disponible
- Depuración: instantáneas de estado/salud/modelos + registro de eventos + llamadas RPC manuales (`status`, `health`, `models.list`)
- Registros: seguimiento en vivo de registros de archivos del gateway con filtro/exportación (`logs.tail`)
- Actualización: ejecutar una actualización de paquete/git + reiniciar (`update.run`) con un reporte de reinicio

Notas del panel de tareas programadas:

- Para trabajos aislados, la entrega predeterminada es anunciar resumen. Puedes cambiar a ninguno si quieres ejecuciones solo internas.
- Los campos de canal/destino aparecen cuando se selecciona anunciar.
- El modo webhook usa `delivery.mode = "webhook"` con `delivery.to` establecido en una URL de webhook HTTP(S) válida.
- Para trabajos de sesión principal, están disponibles los modos de entrega webhook y ninguno.
- Establece `cron.webhookToken` para enviar un token bearer dedicado; si se omite, el webhook se envía sin encabezado de autenticación.
- Respaldo obsoleto: los trabajos heredados almacenados con `notify: true` aún pueden usar `cron.webhook` hasta que se migren.

## Comportamiento del chat

- `chat.send` es **no bloqueante**: reconoce inmediatamente con `{ runId, status: "started" }` y la respuesta se transmite mediante eventos `chat`.
- Reenviar con la misma `idempotencyKey` devuelve `{ status: "in_flight" }` mientras se ejecuta, y `{ status: "ok" }` después de completarse.
- `chat.inject` agrega una nota del asistente a la transcripción de la sesión y transmite un evento `chat` para actualizaciones solo de interfaz (sin ejecución de agente, sin entrega de canal).
- Detener:
  - Haz clic en **Stop** (llama a `chat.abort`)
  - Escribe `/stop` (o `stop|esc|abort|wait|exit|interrupt`) para abortar fuera de banda
  - `chat.abort` admite `{ sessionKey }` (sin `runId`) para abortar todas las ejecuciones activas para esa sesión
- Retención parcial de abortos:
  - Cuando se aborta una ejecución, el texto parcial del asistente aún puede mostrarse en la interfaz
  - El Gateway persiste el texto parcial del asistente abortado en el historial de transcripción cuando existe salida almacenada en búfer
  - Las entradas persistidas incluyen metadatos de aborto para que los consumidores de transcripción puedan distinguir parciales de aborto de salida de finalización normal

## Acceso a Tailnet (recomendado)

### Tailscale Serve integrado (preferido)

Mantén el Gateway en loopback y deja que Tailscale Serve lo proxifique con HTTPS:

```bash
openclaw gateway --tailscale serve
```

Abre:

- `https://<magicdns>/` (o tu `gateway.controlUi.basePath` configurado)

Por defecto, las solicitudes de Serve pueden autenticarse mediante encabezados de identidad de Tailscale
(`tailscale-user-login`) cuando `gateway.auth.allowTailscale` es `true`. OpenClaw
verifica la identidad resolviendo la dirección `x-forwarded-for` con
`tailscale whois` y comparándola con el encabezado, y solo las acepta cuando la
solicitud llega a loopback con los encabezados `x-forwarded-*` de Tailscale. Establece
`gateway.auth.allowTailscale: false` (o fuerza `gateway.auth.mode: "password"`)
si quieres requerir un token/contraseña incluso para el tráfico de Serve.

### Bind a tailnet + token

```bash
openclaw gateway --bind tailnet --token "$(openssl rand -hex 32)"
```

Luego abre:

- `http://<tailscale-ip>:18789/` (o tu `gateway.controlUi.basePath` configurado)

Pega el token en la configuración de la interfaz (enviado como `connect.params.auth.token`).

## HTTP inseguro

Si abres el panel de control sobre HTTP plano (`http://<lan-ip>` o `http://<tailscale-ip>`),
el navegador se ejecuta en un **contexto no seguro** y bloquea WebCrypto. Por defecto,
OpenClaw **bloquea** las conexiones de la Interfaz de Control sin identidad de dispositivo.

**Solución recomendada:** usa HTTPS (Tailscale Serve) o abre la interfaz localmente:

- `https://<magicdns>/` (Serve)
- `http://127.0.0.1:18789/` (en el host del gateway)

**Ejemplo de degradación (solo token sobre HTTP):**

```json5
{
  gateway: {
    controlUi: { allowInsecureAuth: true },
    bind: "tailnet",
    auth: { mode: "token", token: "reemplázame" },
  },
}
```

Esto deshabilita la identidad del dispositivo + emparejamiento para la Interfaz de Control (incluso en HTTPS). Úsalo
solo si confías en la red.

Consulta [Tailscale](/es-ES/gateway/tailscale) para orientación de configuración HTTPS.

## Construcción de la interfaz

El Gateway sirve archivos estáticos desde `dist/control-ui`. Constrúyelos con:

```bash
pnpm ui:build # instala automáticamente las dependencias de la interfaz en la primera ejecución
```

Base absoluta opcional (cuando quieres URLs de recursos fijas):

```bash
OPENCLAW_CONTROL_UI_BASE_PATH=/openclaw/ pnpm ui:build
```

Para desarrollo local (servidor dev separado):

```bash
pnpm ui:dev # instala automáticamente las dependencias de la interfaz en la primera ejecución
```

Luego apunta la interfaz a tu URL WS del Gateway (por ejemplo, `ws://127.0.0.1:18789`).

## Depuración/pruebas: servidor dev + Gateway remoto

La Interfaz de Control son archivos estáticos; el destino del WebSocket es configurable y puede ser
diferente del origen HTTP. Esto es útil cuando quieres el servidor dev de Vite
localmente pero el Gateway se ejecuta en otro lugar.

1. Inicia el servidor dev de la interfaz: `pnpm ui:dev`
2. Abre una URL como:

```text
http://localhost:5173/?gatewayUrl=ws://<gateway-host>:18789
```

Autenticación única opcional (si es necesario):

```text
http://localhost:5173/?gatewayUrl=wss://<gateway-host>:18789&token=<gateway-token>
```

Notas:

- `gatewayUrl` se almacena en localStorage después de cargar y se elimina de la URL.
- `token` se almacena en localStorage; `password` se mantiene solo en memoria.
- Cuando se establece `gatewayUrl`, la interfaz no recurre a credenciales de configuración o entorno.
  Proporciona `token` (o `password`) explícitamente. Faltar credenciales explícitas es un error.
- Usa `wss://` cuando el Gateway esté detrás de TLS (Tailscale Serve, proxy HTTPS, etc.).
- `gatewayUrl` solo se acepta en una ventana de nivel superior (no embebida) para prevenir clickjacking.
- Para configuraciones dev de origen cruzado (por ejemplo, `pnpm ui:dev` a un Gateway remoto), agrega el origen
  de la interfaz a `gateway.controlUi.allowedOrigins`.

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

Detalles de configuración de acceso remoto: [Acceso remoto](/es-ES/gateway/remote).
