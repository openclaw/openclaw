---
summary: "Runbook de solución de problemas en profundidad para gateway, canales, automatización, nodos y navegador"
read_when:
  - El hub de solución de problemas lo dirigió aquí para un diagnóstico más profundo
  - Necesita secciones estables del runbook basadas en síntomas con comandos exactos
title: "Solución de problemas"
---

# Solución de problemas del Gateway

Esta página es el runbook en profundidad.
Comience en [/help/troubleshooting](/help/troubleshooting) si primero desea el flujo de triaje rápido.

## Escalera de comandos

Ejecute estos primero, en este orden:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Señales esperadas de estado saludable:

- `openclaw gateway status` muestra `Runtime: running` y `RPC probe: ok`.
- `openclaw doctor` informa que no hay problemas de configuración/servicio que bloqueen.
- `openclaw channels status --probe` muestra canales conectados/listos.

## Sin respuestas

Si los canales están activos pero nada responde, verifique el enrutamiento y la política antes de reconectar nada.

```bash
openclaw status
openclaw channels status --probe
openclaw pairing list <channel>
openclaw config get channels
openclaw logs --follow
```

Busque:

- Emparejamiento pendiente para los remitentes DM.
- Restricción de menciones en grupos (`requireMention`, `mentionPatterns`).
- Desajustes en la lista de permitidos de canal/grupo.

Firmas comunes:

- `drop guild message (mention required` → mensaje de grupo ignorado hasta que haya una mención.
- `pairing request` → el remitente necesita aprobación.
- `blocked` / `allowlist` → el remitente/canal fue filtrado por la política.

Relacionado:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/pairing](/channels/pairing)
- [/channels/groups](/channels/groups)

## Conectividad de la UI de control del panel

Cuando el panel o la UI de control no se conectan, valide la URL, el modo de autenticación y los supuestos de contexto seguro.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --json
```

Busque:

- URL de sonda y URL del panel correctas.
- Desajuste de modo/token de autenticación entre el cliente y el gateway.
- Uso de HTTP donde se requiere identidad del dispositivo.

Firmas comunes:

- `device identity required` → contexto no seguro o falta autenticación del dispositivo.
- `unauthorized` / bucle de reconexión → desajuste de token/contraseña.
- `gateway connect failed:` → destino de host/puerto/url incorrecto.

Relacionado:

- [/web/control-ui](/web/control-ui)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/remote](/gateway/remote)

## El servicio del Gateway no se está ejecutando

Use esto cuando el servicio está instalado pero el proceso no se mantiene activo.

```bash
openclaw gateway status
openclaw status
openclaw logs --follow
openclaw doctor
openclaw gateway status --deep
```

Busque:

- `Runtime: stopped` con pistas de salida.
- Desajuste de configuración del servicio (`Config (cli)` vs `Config (service)`).
- Conflictos de puertos/escuchas.

Firmas comunes:

- `Gateway start blocked: set gateway.mode=local` → el modo de gateway local no está habilitado.
- `refusing to bind gateway ... without auth` → enlace no loopback sin token/contraseña.
- `another gateway instance is already listening` / `EADDRINUSE` → conflicto de puertos.

Relacionado:

- [/gateway/background-process](/gateway/background-process)
- [/gateway/configuration](/gateway/configuration)
- [/gateway/doctor](/gateway/doctor)

## Canal conectado pero los mensajes no fluyen

Si el estado del canal es conectado pero el flujo de mensajes está inactivo, concéntrese en la política, los permisos y las reglas de entrega específicas del canal.

```bash
openclaw channels status --probe
openclaw pairing list <channel>
openclaw status --deep
openclaw logs --follow
openclaw config get channels
```

Busque:

- Política de mensajes directos (`pairing`, `allowlist`, `open`, `disabled`).
- Lista de permitidos de grupos y requisitos de mención.
- Permisos/alcances de API del canal faltantes.

Firmas comunes:

- `mention required` → mensaje ignorado por la política de mención de grupo.
- `pairing` / trazas de aprobación pendiente → el remitente no está aprobado.
- `missing_scope`, `not_in_channel`, `Forbidden`, `401/403` → problema de autenticación/permisos del canal.

Relacionado:

- [/channels/troubleshooting](/channels/troubleshooting)
- [/channels/whatsapp](/channels/whatsapp)
- [/channels/telegram](/channels/telegram)
- [/channels/discord](/channels/discord)

## Entrega de cron y heartbeat

Si cron o heartbeat no se ejecutaron o no entregaron, verifique primero el estado del programador y luego el destino de entrega.

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw system heartbeat last
openclaw logs --follow
```

Busque:

- Cron habilitado y próxima activación presente.
- Estado del historial de ejecución de trabajos (`ok`, `skipped`, `error`).
- Razones de omisión de heartbeat (`quiet-hours`, `requests-in-flight`, `alerts-disabled`).

Firmas comunes:

- `cron: scheduler disabled; jobs will not run automatically` → cron deshabilitado.
- `cron: timer tick failed` → fallo del tick del programador; revise errores de archivo/log/runtime.
- `heartbeat skipped` con `reason=quiet-hours` → fuera de la ventana de horas activas.
- `heartbeat: unknown accountId` → id de cuenta inválido para el destino de entrega de heartbeat.

Relacionado:

- [/automation/troubleshooting](/automation/troubleshooting)
- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)

## Falla la herramienta de un nodo emparejado

Si un nodo está emparejado pero las herramientas fallan, aísle el estado de primer plano, permisos y aprobación.

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
openclaw status
```

Busque:

- Nodo en línea con las capacidades esperadas.
- Concesiones de permisos del SO para cámara/micrófono/ubicación/pantalla.
- Aprobaciones de exec y estado de la lista de permitidos.

Firmas comunes:

- `NODE_BACKGROUND_UNAVAILABLE` → la app del nodo debe estar en primer plano.
- `*_PERMISSION_REQUIRED` / `LOCATION_PERMISSION_REQUIRED` → falta permiso del SO.
- `SYSTEM_RUN_DENIED: approval required` → aprobación de exec pendiente.
- `SYSTEM_RUN_DENIED: allowlist miss` → comando bloqueado por la lista de permitidos.

Relacionado:

- [/nodes/troubleshooting](/nodes/troubleshooting)
- [/nodes/index](/nodes/index)
- [/tools/exec-approvals](/tools/exec-approvals)

## Falla la herramienta de navegador

Use esto cuando las acciones de la herramienta de navegador fallan aunque el gateway en sí esté saludable.

```bash
openclaw browser status
openclaw browser start --browser-profile openclaw
openclaw browser profiles
openclaw logs --follow
openclaw doctor
```

Busque:

- Ruta válida del ejecutable del navegador.
- Alcanzabilidad del perfil CDP.
- Adjunción de la pestaña de retransmisión de la extensión para `profile="chrome"`.

Firmas comunes:

- `Failed to start Chrome CDP on port` → el proceso del navegador no se pudo iniciar.
- `browser.executablePath not found` → la ruta configurada es inválida.
- `Chrome extension relay is running, but no tab is connected` → la retransmisión de la extensión no está adjunta.
- `Browser attachOnly is enabled ... not reachable` → el perfil de solo adjuntar no tiene un destino alcanzable.

Relacionado:

- [/tools/browser-linux-troubleshooting](/tools/browser-linux-troubleshooting)
- [/tools/chrome-extension](/tools/chrome-extension)
- [/tools/browser](/tools/browser)

## Si actualizó y algo se rompió de repente

La mayoría de las fallas posteriores a una actualización son deriva de configuración o valores predeterminados más estrictos que ahora se están aplicando.

### 1. Cambió el comportamiento de autenticación y anulación de URL

```bash
openclaw gateway status
openclaw config get gateway.mode
openclaw config get gateway.remote.url
openclaw config get gateway.auth.mode
```

Qué verificar:

- Si `gateway.mode=remote`, las llamadas de la CLI pueden estar apuntando a remoto mientras su servicio local está bien.
- Las llamadas explícitas `--url` no recurren a credenciales almacenadas.

Firmas comunes:

- `gateway connect failed:` → destino de URL incorrecto.
- `unauthorized` → endpoint alcanzable pero autenticación incorrecta.

### 2. Los guardarraíles de enlace y autenticación son más estrictos

```bash
openclaw config get gateway.bind
openclaw config get gateway.auth.token
openclaw gateway status
openclaw logs --follow
```

Qué verificar:

- Enlaces no loopback (`lan`, `tailnet`, `custom`) requieren autenticación configurada.
- Claves antiguas como `gateway.token` no reemplazan `gateway.auth.token`.

Firmas comunes:

- `refusing to bind gateway ... without auth` → desajuste entre enlace y autenticación.
- `RPC probe: failed` mientras el runtime está en ejecución → gateway activo pero inaccesible con la autenticación/url actual.

### 3. Cambió el estado de emparejamiento e identidad del dispositivo

```bash
openclaw devices list
openclaw pairing list <channel>
openclaw logs --follow
openclaw doctor
```

Qué verificar:

- Aprobaciones de dispositivos pendientes para el panel/nodos.
- Aprobaciones de emparejamiento de mensajes directos pendientes después de cambios de política o identidad.

Firmas comunes:

- `device identity required` → la autenticación del dispositivo no está satisfecha.
- `pairing required` → el remitente/dispositivo debe ser aprobado.

Si la configuración del servicio y el runtime aún discrepan después de las verificaciones, reinstale los metadatos del servicio desde el mismo directorio de perfil/estado:

```bash
openclaw gateway install --force
openclaw gateway restart
```

Relacionado:

- [/gateway/pairing](/gateway/pairing)
- [/gateway/authentication](/gateway/authentication)
- [/gateway/background-process](/gateway/background-process)
