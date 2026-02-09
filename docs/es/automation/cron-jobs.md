---
summary: "Tareas cron + activaciones para el programador del Gateway"
read_when:
  - Programar tareas de fondo o despertar
  - Conectar automatizaciones que deban ejecutarse con o junto a los latidos
  - Decidir entre latido y cron para tareas programadas
title: "Tareas Cron"
---

# Tareas cron (programador del Gateway)

> **¿Cron vs Latido?** Consulte [Cron vs Latido](/automation/cron-vs-heartbeat) para orientación sobre cuándo usar cada uno.

Cron es el programador integrado del Gateway. Persiste los trabajos, despierta al agente en
el momento adecuado y, de forma opcional, puede entregar la salida de vuelta a un chat.

Si quiere _“ejecutar esto cada mañana”_ o _“avisar al agente en 20 minutos”_,
cron es el mecanismo.

Solución de problemas: [/automation/troubleshooting](/automation/troubleshooting)

## TL;DR

- Cron se ejecuta **dentro del Gateway** (no dentro del modelo).
- Los trabajos persisten bajo `~/.openclaw/cron/` para que los reinicios no pierdan los horarios.
- Dos estilos de ejecución:
  - **Sesión principal**: encola un evento del sistema y luego se ejecuta en el siguiente latido.
  - **Aislado**: ejecuta un turno dedicado del agente en `cron:<jobId>`, con entrega (anuncio por defecto o ninguna).
- Las activaciones son de primera clase: un trabajo puede solicitar “despertar ahora” vs “siguiente latido”.

## Inicio rápido (accionable)

Cree un recordatorio de una sola vez, verifique que existe y ejecútelo de inmediato:

```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id>
```

Programe un trabajo aislado recurrente con entrega:

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## Equivalentes de llamadas de herramienta (herramienta cron del Gateway)

Para las formas JSON canónicas y ejemplos, vea [Esquema JSON para llamadas de herramienta](/automation/cron-jobs#json-schema-for-tool-calls).

## Dónde se almacenan las tareas cron

Las tareas cron se persisten en el host del Gateway en `~/.openclaw/cron/jobs.json` de forma predeterminada.
El Gateway carga el archivo en memoria y lo vuelve a escribir cuando hay cambios, por lo que las ediciones manuales
solo son seguras cuando el Gateway está detenido. Prefiera `openclaw cron add/edit` o la API de llamadas de herramienta
de cron para los cambios.

## Descripción general para principiantes

Piense en una tarea cron como: **cuándo** ejecutar + **qué** hacer.

1. **Elija un horario**
   - Recordatorio de una sola vez → `schedule.kind = "at"` (CLI: `--at`)
   - Trabajo repetitivo → `schedule.kind = "every"` o `schedule.kind = "cron"`
   - Si su marca de tiempo ISO omite una zona horaria, se trata como **UTC**.

2. **Elija dónde se ejecuta**
   - `sessionTarget: "main"` → ejecutar durante el siguiente latido con el contexto principal.
   - `sessionTarget: "isolated"` → ejecutar un turno dedicado del agente en `cron:<jobId>`.

3. **Elija la carga útil**
   - Sesión principal → `payload.kind = "systemEvent"`
   - Sesión aislada → `payload.kind = "agentTurn"`

Opcional: los trabajos de una sola vez (`schedule.kind = "at"`) se eliminan tras el éxito de forma predeterminada. Establezca
`deleteAfterRun: false` para conservarlos (se deshabilitarán tras el éxito).

## Conceptos

### Trabajos

Una tarea cron es un registro almacenado con:

- un **horario** (cuándo debe ejecutarse),
- una **carga útil** (qué debe hacer),
- **modo de entrega** opcional (anuncio o ninguno).
- **vinculación de agente** opcional (`agentId`): ejecutar el trabajo bajo un agente específico; si
  falta o es desconocido, el gateway recurre al agente predeterminado.

Los trabajos se identifican por un `jobId` estable (usado por la CLI/APIs del Gateway).
En llamadas de herramienta del agente, `jobId` es canónico; el legado `id` se acepta por compatibilidad.
Los trabajos de una sola vez se eliminan automáticamente tras el éxito de forma predeterminada; establezca `deleteAfterRun: false` para conservarlos.

### Horarios

Cron admite tres tipos de horario:

- `at`: marca de tiempo de una sola vez mediante `schedule.at` (ISO 8601).
- `every`: intervalo fijo (ms).
- `cron`: expresión cron de 5 campos con zona horaria IANA opcional.

Las expresiones cron usan `croner`. Si se omite una zona horaria, se utiliza la
zona horaria local del host del Gateway.

### Ejecución principal vs aislada

#### Trabajos de sesión principal (eventos del sistema)

Los trabajos principales encolan un evento del sistema y, de forma opcional, despiertan el ejecutor de latidos.
Deben usar `payload.kind = "systemEvent"`.

- `wakeMode: "now"` (predeterminado): el evento dispara una ejecución inmediata del latido.
- `wakeMode: "next-heartbeat"`: el evento espera al siguiente latido programado.

Es la mejor opción cuando desea el prompt normal de latido + el contexto de la sesión principal.
Vea [Latido](/gateway/heartbeat).

#### Trabajos aislados (sesiones cron dedicadas)

Los trabajos aislados ejecutan un turno dedicado del agente en la sesión `cron:<jobId>`.

Comportamientos clave:

- El prompt se prefija con `[cron:<jobId> <job name>]` para trazabilidad.
- Cada ejecución inicia un **id de sesión nuevo** (sin arrastre de conversaciones previas).
- Comportamiento predeterminado: si se omite `delivery`, los trabajos aislados anuncian un resumen (`delivery.mode = "announce"`).
- `delivery.mode` (solo aislado) elige qué sucede:
  - `announce`: entrega un resumen al canal objetivo y publica un breve resumen en la sesión principal.
  - `none`: solo interno (sin entrega ni resumen de sesión principal).
- `wakeMode` controla cuándo se publica el resumen de la sesión principal:
  - `now`: latido inmediato.
  - `next-heartbeat`: espera al siguiente latido programado.

Use trabajos aislados para tareas ruidosas, frecuentes o de “trabajos en segundo plano” que no deberían
saturar el historial del chat principal.

### Formas de carga útil (qué se ejecuta)

Se admiten dos tipos de carga útil:

- `systemEvent`: solo sesión principal, enrutada a través del prompt de latido.
- `agentTurn`: solo sesión aislada, ejecuta un turno dedicado del agente.

Campos comunes de `agentTurn`:

- `message`: texto de prompt requerido.
- `model` / `thinking`: anulaciones opcionales (ver abajo).
- `timeoutSeconds`: anulación opcional del tiempo de espera.

Configuración de entrega (solo trabajos aislados):

- `delivery.mode`: `none` | `announce`.
- `delivery.channel`: `last` o un canal específico.
- `delivery.to`: objetivo específico del canal (teléfono/chat/id de canal).
- `delivery.bestEffort`: evitar que el trabajo falle si la entrega del anuncio falla.

La entrega por anuncio suprime los envíos de herramientas de mensajería para la ejecución; use `delivery.channel`/`delivery.to`
para apuntar al chat en su lugar. Cuando `delivery.mode = "none"`, no se publica ningún resumen en la sesión principal.

Si se omite `delivery` para trabajos aislados, OpenClaw usa por defecto `announce`.

#### Flujo de entrega por anuncio

Cuando `delivery.mode = "announce"`, cron entrega directamente a través de los adaptadores de canal saliente.
El agente principal no se inicia para elaborar ni reenviar el mensaje.

Detalles de comportamiento:

- Contenido: la entrega usa las cargas salientes (texto/medios) de la ejecución aislada con fragmentación normal y
  formato del canal.
- Las respuestas solo de latido (`HEARTBEAT_OK` sin contenido real) no se entregan.
- Si la ejecución aislada ya envió un mensaje al mismo objetivo mediante la herramienta de mensajería, la entrega se
  omite para evitar duplicados.
- Los objetivos de entrega faltantes o inválidos hacen fallar el trabajo a menos que `delivery.bestEffort = true`.
- Un breve resumen se publica en la sesión principal solo cuando `delivery.mode = "announce"`.
- El resumen de la sesión principal respeta `wakeMode`: `now` dispara un latido inmediato y
  `next-heartbeat` espera al siguiente latido programado.

### Anulaciones de modelo y pensamiento

Los trabajos aislados (`agentTurn`) pueden anular el modelo y el nivel de pensamiento:

- `model`: cadena proveedor/modelo (p. ej., `anthropic/claude-sonnet-4-20250514`) o alias (p. ej., `opus`)
- `thinking`: nivel de pensamiento (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`; solo modelos GPT-5.2 + Codex)

Nota: También puede establecer `model` en trabajos de sesión principal, pero cambia el modelo compartido de la
sesión principal. Recomendamos las anulaciones de modelo solo para trabajos aislados para evitar
cambios de contexto inesperados.

Prioridad de resolución:

1. Anulación en la carga del trabajo (más alta)
2. Valores predeterminados específicos del hook (p. ej., `hooks.gmail.model`)
3. Predeterminado de configuración del agente

### Entrega (canal + objetivo)

Los trabajos aislados pueden entregar la salida a un canal mediante la configuración de nivel superior `delivery`:

- `delivery.mode`: `announce` (entregar un resumen) o `none`.
- `delivery.channel`: `whatsapp` / `telegram` / `discord` / `slack` / `mattermost` (plugin) / `signal` / `imessage` / `last`.
- `delivery.to`: objetivo del destinatario específico del canal.

La configuración de entrega solo es válida para trabajos aislados (`sessionTarget: "isolated"`).

Si se omite `delivery.channel` o `delivery.to`, cron puede recurrir a la “última ruta” de la sesión principal
(el último lugar donde respondió el agente).

Recordatorios de formato de objetivos:

- Los objetivos de Slack/Discord/Mattermost (plugin) deben usar prefijos explícitos (p. ej., `channel:<id>`, `user:<id>`) para evitar ambigüedades.
- Los temas de Telegram deben usar el formato `:topic:` (ver abajo).

#### Objetivos de entrega de Telegram (temas / hilos de foro)

Telegram admite temas de foro mediante `message_thread_id`. Para la entrega de cron, puede codificar
el tema/hilo en el campo `to`:

- `-1001234567890` (solo id de chat)
- `-1001234567890:topic:123` (preferido: marcador de tema explícito)
- `-1001234567890:123` (atajo: sufijo numérico)

También se aceptan objetivos con prefijo como `telegram:...` / `telegram:group:...`:

- `telegram:group:-1001234567890:topic:123`

## Esquema JSON para llamadas de herramienta

Use estas formas al llamar directamente a las herramientas `cron.*` del Gateway (llamadas de herramienta del agente o RPC).
Las banderas de la CLI aceptan duraciones humanas como `20m`, pero las llamadas de herramienta deben usar una cadena ISO 8601
para `schedule.at` y milisegundos para `schedule.everyMs`.

### Parámetros de cron.add

Trabajo de una sola vez, sesión principal (evento del sistema):

```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
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
    "message": "Summarize overnight updates."
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
- `everyMs` son milisegundos.
- `sessionTarget` debe ser `"main"` o `"isolated"` y debe coincidir con `payload.kind`.
- Campos opcionales: `agentId`, `description`, `enabled`, `deleteAfterRun` (predetermina true para `at`),
  `delivery`.
- `wakeMode` predetermina `"now"` cuando se omite.

### Parámetros de cron.update

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
- Use `agentId: null` en el parche para borrar una vinculación de agente.

### Parámetros de cron.run y cron.remove

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## Almacenamiento e historial

- Almacén de trabajos: `~/.openclaw/cron/jobs.json` (JSON administrado por el Gateway).
- Historial de ejecuciones: `~/.openclaw/cron/runs/<jobId>.jsonl` (JSONL, depuración automática).
- Anular la ruta del almacén: `cron.store` en la configuración.

## Configuración

```json5
{
  cron: {
    enabled: true, // default true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // default 1
  },
}
```

Deshabilitar cron por completo:

- `cron.enabled: false` (configuración)
- `OPENCLAW_SKIP_CRON=1` (entorno)

## Inicio rápido de la CLI

Recordatorio de una sola vez (ISO UTC, autoeliminación tras el éxito):

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

Recordatorio de una sola vez (sesión principal, despertar de inmediato):

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

Trabajo aislado recurrente (anunciar a WhatsApp):

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
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
  --message "Summarize today; send to the nightly topic." \
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
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Selección de agente (configuraciones multiagente):

```bash
# Pin a job to agent "ops" (falls back to default if that agent is missing)
openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# Switch or clear the agent on an existing job
openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

Ejecución manual (forzar es el valor predeterminado; use `--due` para ejecutar solo cuando corresponda):

```bash
openclaw cron run <jobId>
openclaw cron run <jobId> --due
```

Editar un trabajo existente (parchear campos):

```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

Historial de ejecuciones:

```bash
openclaw cron runs --id <jobId> --limit 50
```

Evento del sistema inmediato sin crear un trabajo:

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Superficie de la API del Gateway

- `cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`
- `cron.run` (forzar o debido), `cron.runs`
  Para eventos del sistema inmediatos sin un trabajo, use [`openclaw system event`](/cli/system).

## Solución de problemas

### “Nada se ejecuta”

- Verifique que cron esté habilitado: `cron.enabled` y `OPENCLAW_SKIP_CRON`.
- Verifique que el Gateway se esté ejecutando de forma continua (cron se ejecuta dentro del proceso del Gateway).
- Para horarios `cron`: confirme la zona horaria (`--tz`) frente a la zona horaria del host.

### Un trabajo recurrente sigue retrasándose tras fallas

- OpenClaw aplica retroceso exponencial de reintentos para trabajos recurrentes tras errores consecutivos:
  30 s, 1 min, 5 min, 15 min y luego 60 min entre reintentos.
- El retroceso se restablece automáticamente tras la siguiente ejecución exitosa.
- Los trabajos de una sola vez (`at`) se deshabilitan tras una ejecución terminal (`ok`, `error` o `skipped`) y no reintentan.

### Telegram entrega en el lugar incorrecto

- Para temas de foro, use `-100…:topic:<id>` para que sea explícito y sin ambigüedades.
- Si ve prefijos `telegram:...` en los registros o en los objetivos de “última ruta” almacenados, es normal;
  la entrega de cron los acepta y aun así analiza correctamente los IDs de tema.
