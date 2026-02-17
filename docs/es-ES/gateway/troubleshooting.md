---
summary: "Manual de solución profunda de problemas para gateway, canales, automatización, nodos y navegador"
read_when:
  - El centro de solución de problemas te dirigió aquí para un diagnóstico más profundo
  - Necesitas secciones de manual estables basadas en síntomas con comandos exactos
title: "Solución de problemas"
---

# Solución de problemas del Gateway

Esta página es el manual profundo.
Comienza en [/help/troubleshooting](/es-ES/help/troubleshooting) si quieres primero el flujo rápido de triaje.

## Escalera de comandos

Ejecuta estos primero, en este orden:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Señales saludables esperadas:

- `openclaw gateway status` muestra `Runtime: running` y `RPC probe: ok`.
- `openclaw doctor` no reporta problemas de configuración/servicio bloqueantes.
- `openclaw channels status --probe` muestra canales conectados/listos.

## Sin respuestas

Si los canales están activos pero nada responde, verifica el enrutamiento y la política antes de reconectar cualquier cosa.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Busca:

- Emparejamiento pendiente para remitentes de mensajes directos.
- Control de menciones de grupo (`requireMention`, `mentionPatterns`).
- Desajustes en lista de permitidos de canal/grupo.

Firmas comunes:

- `drop guild message (mention required` → mensaje de grupo ignorado hasta mención.
- `pairing request` → remitente necesita aprobación.
- `blocked` / `allowlist` → remitente/canal fue filtrado por política.

Relacionado:

- [/channels/troubleshooting](/es-ES/channels/troubleshooting)
- [/channels/pairing](/es-ES/channels/pairing)
- [/channels/groups](/es-ES/channels/groups)

## Conectividad de interfaz de control del panel

Cuando el panel/interfaz de control no se conecta, valida URL, modo de autenticación y supuestos de contexto seguro.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Busca:

- URL de sonda y URL de panel correctas.
- Desajuste de modo de autenticación/token entre cliente y gateway.
- Uso de HTTP donde se requiere identidad de dispositivo.

Firmas comunes:

- `device identity required` → contexto no seguro o autenticación de dispositivo faltante.
- `unauthorized` / bucle de reconexión → desajuste de token/contraseña.
- `gateway connect failed:` → objetivo de host/puerto/url incorrecto.

Relacionado:

- [/web/control-ui](/es-ES/web/control-ui)
- [/gateway/authentication](/es-ES/gateway/authentication)
- [/gateway/remote](/es-ES/gateway/remote)

## Servicio Gateway no está ejecutándose

Usa esto cuando el servicio está instalado pero el proceso no se mantiene activo.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Busca:

- `Runtime: stopped` con sugerencias de salida.
- Desajuste de configuración de servicio (`Config (cli)` vs `Config (service)`).
- Conflictos de puerto/escucha.

Firmas comunes:

- `Gateway start blocked: set gateway.mode=local` → modo de gateway local no está habilitado. Solución: establece `gateway.mode="local"` en tu configuración (o ejecuta `openclaw configure`). Si estás ejecutando OpenClaw vía Podman usando el usuario dedicado `openclaw`, la configuración está en `~openclaw/.openclaw/openclaw.json`.
- `refusing to bind gateway ... without auth` → vinculación no-loopback sin token/contraseña.
- `another gateway instance is already listening` / `EADDRINUSE` → conflicto de puerto.

Relacionado:

- [/gateway/background-process](/es-ES/gateway/background-process)
- [/gateway/configuration](/es-ES/gateway/configuration)
- [/gateway/doctor](/es-ES/gateway/doctor)

## Canal conectado pero mensajes no fluyen

Si el estado del canal está conectado pero el flujo de mensajes está muerto, enfócate en política, permisos y reglas de entrega específicas del canal.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Busca:

- Política de mensajes directos (`pairing`, `allowlist`, `open`, `disabled`).
- Lista de permitidos de grupo y requisitos de mención.
- Permisos/ámbitos de API del canal faltantes.

Firmas comunes:

- `mention required` → mensaje ignorado por política de mención de grupo.
- `pairing` / trazas de aprobación pendiente → remitente no está aprobado.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → problema de autenticación/permisos del canal.

Relacionado:

- [/channels/troubleshooting](/es-ES/channels/troubleshooting)
- [/channels/whatsapp](/es-ES/channels/whatsapp)
- [/channels/telegram](/es-ES/channels/telegram)
- [/channels/discord](/es-ES/channels/discord)

## Entrega de cron y heartbeat

Si cron o heartbeat no se ejecutaron o no se entregaron, verifica el estado del programador primero, luego el objetivo de entrega.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Busca:

- Cron habilitado y siguiente activación presente.
- Estado del historial de ejecución del trabajo (`ok`, `skipped`, `error`).
- Razones de omisión de heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Firmas comunes:

- `cron: scheduler disabled; jobs will not run automatically` → cron deshabilitado.
- `cron: timer tick failed` → tick del programador falló; verifica errores de archivo/registro/ejecución.
- `heartbeat skipped` con `reason=quiet-hours` → fuera de ventana de horas activas.
- `heartbeat: unknown accountId` → id de cuenta inválido para objetivo de entrega de heartbeat.

Relacionado:

- [/automation/troubleshooting](/es-ES/automation/troubleshooting)
- [/automation/cron-jobs](/es-ES/automation/cron-jobs)
- [/gateway/heartbeat](/es-ES/gateway/heartbeat)

## Falla de herramienta de nodo emparejado

Si un nodo está emparejado pero las herramientas fallan, aísla el estado de primer plano, permisos y aprobación.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Busca:

- Nodo en línea con capacidades esperadas.
- Permisos del sistema operativo para cámara/micrófono/ubicación/pantalla.
- Estado de aprobaciones de ejecución y lista de permitidos.

Firmas comunes:

- `NODE_BACKGROUND_UNAVAILABLE` → aplicación del nodo debe estar en primer plano.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → permiso del sistema operativo faltante.
- `SYSTEM_RUN_DENIED: approval required` → aprobación de ejecución pendiente.
- `SYSTEM_RUN_DENIED: allowlist miss` → comando bloqueado por lista de permitidos.

Relacionado:

- [/nodes/troubleshooting](/es-ES/nodes/troubleshooting)
- [/nodes/index](/es-ES/nodes/index)
- [/tools/exec-approvals](/es-ES/tools/exec-approvals)

## Falla de herramienta de navegador

Usa esto cuando las acciones de la herramienta de navegador fallan incluso aunque el gateway mismo esté saludable.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Busca:

- Ruta de ejecutable de navegador válida.
- Alcanzabilidad del perfil CDP.
- Adjunto de pestaña de relé de extensión para `profile="chrome"`.

Firmas comunes:

- `Failed to start Chrome CDP on port` → proceso de navegador falló al iniciar.
- `browser.executablePath not found` → ruta configurada es inválida.
- `Chrome extension relay is running, but no tab is connected` → relé de extensión no está adjunto.
- `Browser attachOnly is enabled ... not reachable` → perfil de solo adjuntar no tiene objetivo alcanzable.

Relacionado:

- [/tools/browser-linux-troubleshooting](/es-ES/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/es-ES/tools/chrome-extension)
- [/tools/browser](/es-ES/tools/browser)

## Si actualizaste y algo se rompió repentinamente

La mayoría de las roturas post-actualización son deriva de configuración o valores predeterminados más estrictos ahora siendo aplicados.

### 1) Comportamiento de autenticación y anulación de URL cambió

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Qué verificar:

- Si `gateway.mode=remote`, las llamadas CLI pueden estar dirigiéndose al remoto mientras tu servicio local está bien.
- Las llamadas `--url` explícitas no recurren a credenciales almacenadas.

Firmas comunes:

- `gateway connect failed:` → objetivo de URL incorrecto.
- `unauthorized` → endpoint alcanzable pero autenticación incorrecta.

### 2) Las barreras de protección de vinculación y autenticación son más estrictas

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Qué verificar:

- Las vinculaciones no-loopback (`lan`, `tailnet`, `custom`) necesitan autenticación configurada.
- Las claves antiguas como `gateway.token` no reemplazan `gateway.auth.token`.

Firmas comunes:

- `refusing to bind gateway ... without auth` → desajuste de vinculación+autenticación.
- `RPC probe: failed` mientras el runtime está corriendo → gateway vivo pero inaccesible con autenticación/url actual.

### 3) El estado de emparejamiento e identidad de dispositivo cambió

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Qué verificar:

- Aprobaciones de dispositivo pendientes para panel/nodos.
- Aprobaciones de emparejamiento de mensajes directos pendientes después de cambios de política o identidad.

Firmas comunes:

- `device identity required` → autenticación de dispositivo no satisfecha.
- `pairing required` → remitente/dispositivo debe ser aprobado.

Si la configuración del servicio y el runtime aún no concuerdan después de las verificaciones, reinstala metadatos del servicio desde el mismo directorio de perfil/estado:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Relacionado:

- [/gateway/pairing](/es-ES/gateway/pairing)
- [/gateway/authentication](/es-ES/gateway/authentication)
- [/gateway/background-process](/es-ES/gateway/background-process)
