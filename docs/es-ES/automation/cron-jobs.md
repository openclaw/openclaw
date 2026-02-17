---
summary: "Tareas programadas + activaciones para el programador del Gateway"
read_when:
  - Programando trabajos en segundo plano o activaciones
  - Configurando automatización que debe ejecutarse con o junto a heartbeats
  - Decidiendo entre heartbeat y cron para tareas programadas
title: "Tareas Programadas"
---

# Tareas programadas (Programador del Gateway)

> **¿Cron vs Heartbeat?** Ver [Cron vs Heartbeat](/es-ES/automation/cron-vs-heartbeat) para orientación sobre cuándo usar cada uno.

Cron es el programador integrado del Gateway. Persiste trabajos, despierta al agente en
el momento correcto, y puede opcionalmente entregar la salida de vuelta a un chat.

Si quieres _"ejecutar esto cada mañana"_ o _"avisar al agente en 20 minutos"_,
cron es el mecanismo.

Solución de problemas: [/automation/troubleshooting](/es-ES/automation/troubleshooting)

## Resumen

- Cron se ejecuta **dentro del Gateway** (no dentro del modelo).
- Los trabajos persisten bajo `~/.openclaw/cron/` así que los reinicios no pierden programaciones.
- Dos estilos de ejecución:
  - **Sesión principal**: encola un evento del sistema, luego ejecuta en el próximo heartbeat.
  - **Aislado**: ejecuta un turno de agente dedicado en `cron:<jobId>`, con entrega (anunciar por defecto o ninguno).
- Las activaciones son de primera clase: un trabajo puede solicitar "despertar ahora" vs "próximo heartbeat".
- La publicación de webhook es por trabajo mediante `delivery.mode = "webhook"` + `delivery.to = "<url>"`.
- El respaldo heredado permanece para trabajos almacenados con `notify: true` cuando se establece `cron.webhook`, migra esos trabajos al modo de entrega webhook.

## Inicio rápido (accionable)

Crear un recordatorio de una sola vez, verificar que existe, y ejecutarlo inmediatamente:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Recordatorio: revisar el borrador de documentos de cron" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Programar un trabajo aislado recurrente con entrega:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Resumir actualizaciones nocturnas." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Equivalentes de llamada de herramienta (herramienta cron del Gateway)

Para las formas JSON canónicas y ejemplos, ver [Esquema JSON para llamadas de herramientas](/es-ES/automation/cron-jobs#json-schema-for-tool-calls).

## Dónde se almacenan los trabajos cron

Los trabajos cron se persisten en el host Gateway en `~/.openclaw/cron/jobs.json` por defecto.
El Gateway carga el archivo en memoria y lo escribe de vuelta en cambios, así que las ediciones manuales
solo son seguras cuando el Gateway está detenido. Prefiere `openclaw cron add/edit` o la API de llamada de herramienta cron para cambios.

## Vista general amigable para principiantes

Piensa en un trabajo cron como: **cuándo** ejecutar + **qué** hacer.

1. **Elegir una programación**
   - Recordatorio de una sola vez → `schedule.kind = "at"` (CLI: `--at`)
   - Trabajo repetitivo → `schedule.kind = "every"` o `schedule.kind = "cron"`
   - Si tu marca de tiempo ISO omite una zona horaria, se trata como **UTC**.

2. **Elegir dónde se ejecuta**
   - `sessionTarget: "main"` → ejecutar durante el próximo heartbeat con contexto principal.
   - `sessionTarget: "isolated"` → ejecutar un turno de agente dedicado en `cron:<jobId>`.

3. **Elegir la carga útil**
   - Sesión principal → `payload.kind = "systemEvent"`
   - Sesión aislada → `payload.kind = "agentTurn"`

Opcional: los trabajos de una sola vez (`schedule.kind = "at"`) se eliminan después del éxito por defecto. Establece
`deleteAfterRun: false` para mantenerlos (se deshabilitarán después del éxito).

## Conceptos

### Trabajos

Un trabajo cron es un registro almacenado con:

- una **programación** (cuándo debe ejecutarse),
- una **carga útil** (qué debe hacer),
- **modo de entrega** opcional (`announce`, `webhook`, o `none`).
- **vinculación de agente** opcional (`agentId`): ejecutar el trabajo bajo un agente específico; si
  falta o es desconocido, el gateway vuelve al agente por defecto.

Los trabajos se identifican por un `jobId` estable (usado por APIs CLI/Gateway).
En llamadas de herramientas de agente, `jobId` es canónico; el heredado `id` se acepta por compatibilidad.
Los trabajos de una sola vez se auto-eliminan después del éxito por defecto; establece `deleteAfterRun: false` para mantenerlos.

### Programaciones

Cron admite tres tipos de programación:

- `at`: marca de tiempo de una sola vez mediante `schedule.at` (ISO 8601).
- `every`: intervalo fijo (ms).
- `cron`: expresión cron de 5 campos con zona horaria IANA opcional.

Las expresiones cron usan `croner`. Si se omite una zona horaria, se usa la
zona horaria local del host Gateway.

### Ejecución principal vs aislada

#### Trabajos de sesión principal (eventos del sistema)

Los trabajos principales encolan un evento del sistema y opcionalmente despiertan el ejecutor de heartbeat.
Deben usar `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (por defecto): el evento activa una ejecución de heartbeat inmediata.
- `wakeMode: "next-heartbeat"`: el evento espera el próximo heartbeat programado.

Esta es la mejor opción cuando quieres el prompt de heartbeat normal + contexto de sesión principal.
Ver [Heartbeat](/es-ES/gateway/heartbeat).

#### Trabajos aislados (sesiones cron dedicadas)

Los trabajos aislados ejecutan un turno de agente dedicado en la sesión `cron:<jobId>`.

Comportamientos clave:

- El prompt tiene prefijo con `[cron:<jobId> <nombre del trabajo>]` para trazabilidad.
- Cada ejecución inicia un **id de sesión nuevo** (sin arrastre de conversación previa).
- Comportamiento por defecto: si se omite `delivery`, los trabajos aislados anuncian un resumen (`delivery.mode = "announce"`).
- `delivery.mode` elige qué sucede:
  - `announce`: entregar un resumen al canal objetivo y publicar un breve resumen en la sesión principal.
  - `webhook`: POST de la carga útil del evento finalizado a `delivery.to`.
  - `none`: solo interno (sin entrega, sin resumen de sesión principal).
- `wakeMode` controla cuándo se publica el resumen de sesión principal:
  - `now`: heartbeat inmediato.
  - `next-heartbeat`: espera el próximo heartbeat programado.

Usa trabajos aislados para "tareas de fondo" ruidosas, frecuentes o que no deberían saturar
tu historial de chat principal.

### Formas de carga útil (qué se ejecuta)

Se admiten dos tipos de carga útil:

- `systemEvent`: solo sesión principal, enrutado a través del prompt de heartbeat.
- `agentTurn`: solo sesión aislada, ejecuta un turno de agente dedicado.

Campos comunes de `agentTurn`:

- `message`: prompt de texto requerido.
- `model` / `thinking`: anulaciones opcionales (ver abajo).
- `timeoutSeconds`: anulación de timeout opcional.

Config de entrega:

- `delivery.mode`: `none` | `announce` | `webhook`.
- `delivery.channel`: `last` o un canal específico.
- `delivery.to`: objetivo específico del canal (announce) o URL webhook (modo webhook).
- `delivery.bestEffort`: evitar que falle el trabajo si falla la entrega de announce.

La entrega de announce suprime los envíos de herramientas de mensajería para la ejecución; usa `delivery.channel`/`delivery.to`
para dirigirse al chat en su lugar. Cuando `delivery.mode = "none"`, no se publica ningún resumen en la sesión principal.

Si se omite `delivery` para trabajos aislados, OpenClaw por defecto a `announce`.

#### Flujo de entrega de announce

Cuando `delivery.mode = "announce"`, cron entrega directamente mediante los adaptadores de canal de salida.
El agente principal no se activa para elaborar o reenviar el mensaje.

Detalles de comportamiento:

- Contenido: la entrega usa las cargas útiles de salida de la ejecución aislada (texto/medios) con fragmentación normal y
  formato de canal.
- Las respuestas solo de heartbeat (`HEARTBEAT_OK` sin contenido real) no se entregan.
- Si la ejecución aislada ya envió un mensaje al mismo objetivo mediante la herramienta de mensaje, la entrega se
  omite para evitar duplicados.
- Los objetivos de entrega faltantes o inválidos fallan el trabajo a menos que `delivery.bestEffort = true`.
- Se publica un breve resumen en la sesión principal solo cuando `delivery.mode = "announce"`.
- El resumen de sesión principal respeta `wakeMode`: `now` activa un heartbeat inmediato y
  `next-heartbeat` espera el próximo heartbeat programado.

#### Flujo de entrega de webhook

Cuando `delivery.mode = "webhook"`, cron publica la carga útil del evento finalizado en `delivery.to`.

Detalles de comportamiento:

- El endpoint debe ser una URL HTTP(S) válida.
- No se intenta entrega de canal en modo webhook.
- No se publica resumen de sesión principal en modo webhook.
- Si se establece `cron.webhookToken`, el encabezado de autenticación es `Authorization: Bearer <cron.webhookToken>`.
- Respaldo obsoleto: los trabajos heredados almacenados con `notify: true` aún publican en `cron.webhook` (si está configurado), con una advertencia para que puedas migrar a `delivery.mode = "webhook"`.

### Anulaciones de modelo y pensamiento

Los trabajos aislados (`agentTurn`) pueden anular el modelo y nivel de pensamiento:

- `model`: Cadena de proveedor/modelo (ej. `anthropic/claude-sonnet-4-20250514`) o alias (ej. `opus`)
- `thinking`: Nivel de pensamiento (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; solo modelos GPT-5.2 + Codex)

Nota: También puedes establecer `model` en trabajos de sesión principal, pero cambia el modelo de sesión principal compartida. Recomendamos anulaciones de modelo solo para trabajos aislados para evitar
cambios de contexto inesperados.

Prioridad de resolución:

1. Anulación de carga útil de trabajo (más alta)
2. Valores por defecto específicos de hook (ej. `hooks.gmail.model`)
3. Valor por defecto de configuración de agente

### Entrega (canal + objetivo)

Los trabajos aislados pueden entregar salida a un canal mediante la configuración `delivery` de nivel superior:

- `delivery.mode`: `announce` (entrega de canal), `webhook` (HTTP POST), o `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: identificador de destinatario específico del canal.

La entrega `announce` solo es válida para trabajos aislados (`sessionTarget: "isolated"`).
La entrega `webhook` es válida tanto para trabajos principales como aislados.

Si se omiten `delivery.channel` o `delivery.to`, cron puede volver a la
"última ruta" de la sesión principal (el último lugar donde el agente respondió).

Recordatorios de formato de objetivo:

- Los objetivos de Slack/Discord/Mattermost (plugin) deben usar prefijos explícitos (ej. `channel:<id>`, `user:<id>`) para evitar ambigüedad.
- Los temas de Telegram deben usar la forma `:topic:` (ver abajo).

#### Objetivos de entrega de Telegram (temas / hilos de foro)

Telegram admite temas de foro mediante `message_thread_id`. Para entrega de cron, puedes codificar
el tema/hilo en el campo `to`:

- `-1001234567890` (solo id de chat)
- `-1001234567890:topic:123` (preferido: marcador de tema explícito)
- `-1001234567890:123` (abreviatura: sufijo numérico)

Los objetivos con prefijo como `telegram:...` / `telegram:group:...` también se aceptan:

- `telegram:group:-1001234567890:topic:123`

## Esquema JSON para llamadas de herramientas

Usa estas formas al llamar herramientas `cron.*` del Gateway directamente (llamadas de herramientas de agente o RPC).
Los flags CLI aceptan duraciones humanas como `20m`, pero las llamadas de herramientas deben usar una cadena ISO 8601
para `schedule.at` y milisegundos para `schedule.everyMs`.

### cron.add params

Trabajo de una sola vez, sesión principal (evento del sistema):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Texto del recordatorio" },
  "deleteAfterRun": true
}
```

Trabajo recurrente, aislado con entrega:

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Resumir actualizaciones nocturnas."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

Notas:

- `schedule.kind`: `at` (`at`), `every` (`everyMs`), o `cron` (`expr`, `tz` opcional).
- `schedule.at` acepta ISO 8601 (zona horaria opcional; tratada como UTC cuando se omite).
- `everyMs` es milisegundos.
- `sessionTarget` debe ser `"main"` o `"isolated"` y debe coincidir con `payload.kind`.
- Campos opcionales: `agentId`, `description`, `enabled`, `deleteAfterRun` (por defecto true para `at`),
  `delivery`.
- `wakeMode` por defecto a `"now"` cuando se omite.

### cron.update params

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

Notas:

- `jobId` es canónico; `id` se acepta por compatibilidad.
- Usa `agentId: null` en el parche para limpiar una vinculación de agente.

### cron.run y cron.remove params

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Almacenamiento e historial

- Almacén de trabajos: `~/.openclaw/cron/jobs.json` (JSON gestionado por Gateway).
- Historial de ejecuciones: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, auto-podado).
- Anular ruta de almacén: `cron.store` en config.

## Configuración

```json5
{
  cron: {
    enabled: true, // por defecto true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // por defecto 1
    webhook: "https://example.invalid/legacy", // respaldo obsoleto para trabajos almacenados con notify:true
    webhookToken: "reemplazar-con-token-webhook-dedicado", // token bearer opcional para modo webhook
  },
}
```

Comportamiento de webhook:

- Preferido: establecer `delivery.mode: "webhook"` con `delivery.to: "https://..."` por trabajo.
- Las URLs de webhook deben ser URLs válidas `http://` o `https://`.
- La carga útil es el JSON del evento finalizado de cron.
- Si se establece `cron.webhookToken`, el encabezado de autenticación es `Authorization: Bearer <cron.webhookToken>`.
- Si no se establece `cron.webhookToken`, no se envía encabezado `Authorization`.
- Respaldo obsoleto: los trabajos heredados almacenados con `notify: true` aún usan `cron.webhook` cuando está presente.

Deshabilitar cron completamente:

- `cron.enabled: false` (config)
- `OPENCLAW_SKIP_CRON=1` (env)

## Inicio rápido CLI

Recordatorio de una sola vez (ISO UTC, auto-eliminar después del éxito):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Recordatorio: enviar informe de gastos." \
  --wake now \
  --delete-after-run
```

Recordatorio de una sola vez (sesión principal, despertar inmediatamente):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Próximo heartbeat: revisar calendario." \
  --wake now
```

Trabajo aislado recurrente (anunciar a WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Resumir bandeja de entrada + calendario para hoy." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Trabajo aislado recurrente (entregar a un tema de Telegram):

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Resumir hoy; enviar al tema nocturno." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

Trabajo aislado con anulación de modelo y pensamiento:

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Análisis profundo semanal del progreso del proyecto." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Selección de agente (configuraciones multi-agente):

```bash
# Fijar un trabajo al agente "ops" (vuelve al predeterminado si ese agente falta)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Revisar cola de ops" --agent ops

# Cambiar o limpiar el agente en un trabajo existente
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Ejecución manual (force es el predeterminado, usa `--due` para ejecutar solo cuando sea debido):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Editar un trabajo existente (parchear campos):

```bash
openclaw cron edit <jobId> \
  --message "Prompt actualizado" \
  --model "opus" \
  --thinking low
```

Historial de ejecuciones:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Evento del sistema inmediato sin crear un trabajo:

```bash
openclaw system event --mode now --text "Próximo heartbeat: revisar batería."
```

## Superficie API del Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (force o due), `cron.runs`
  Para eventos del sistema inmediatos sin un trabajo, usa [`openclaw system event`](/es-ES/cli/system).

## Solución de problemas

### "Nada se ejecuta"

- Verifica que cron está habilitado: `cron.enabled` y `OPENCLAW_SKIP_CRON`.
- Verifica que el Gateway está ejecutándose continuamente (cron se ejecuta dentro del proceso Gateway).
- Para programaciones `cron`: confirma zona horaria (`--tz`) vs la zona horaria del host.

### Un trabajo recurrente sigue retrasándose después de fallos

- OpenClaw aplica retraso de reintento exponencial para trabajos recurrentes después de errores consecutivos:
  30s, 1m, 5m, 15m, luego 60m entre reintentos.
- El retraso se reinicia automáticamente después de la próxima ejecución exitosa.
- Los trabajos de una sola vez (`at`) se deshabilitan después de una ejecución terminal (`ok`, `error`, o `skipped`) y no reintentan.

### Telegram entrega al lugar equivocado

- Para temas de foro, usa `-100…:topic:<id>` para que sea explícito y sin ambigüedad.
- Si ves prefijos `telegram:...` en registros o objetivos "última ruta" almacenados, eso es normal;
  la entrega de cron los acepta y aún analiza IDs de tema correctamente.

### Reintentos de entrega de announce de subagente

- Cuando una ejecución de subagente se completa, el gateway anuncia el resultado a la sesión solicitante.
- Si el flujo de announce retorna `false` (ej. la sesión solicitante está ocupada), el gateway reintenta hasta 3 veces con seguimiento mediante `announceRetryCount`.
- Los announces más antiguos de 5 minutos después de `endedAt` se expiran forzadamente para prevenir que las entradas obsoletas se repitan indefinidamente.
- Si ves entregas de announce repetidas en registros, verifica el registro de subagente para entradas con valores altos de `announceRetryCount`.
