---
summary: "Herramientas de sesión del agente para listar sesiones, obtener historial y enviar mensajes entre sesiones"
read_when:
  - Al agregar o modificar herramientas de sesión
title: "Herramientas de sesión"
---

# Herramientas de sesión

Objetivo: conjunto de herramientas pequeño y difícil de usar incorrectamente para que los agentes puedan listar sesiones, obtener historial y enviar a otra sesión.

## Nombres de herramientas

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

## Modelo de claves

- El bucket principal de chat directo siempre es la clave literal `"main"` (resuelta a la clave principal del agente actual).
- Los chats grupales usan `agent:<agentId>:<channel>:group:<id>` o `agent:<agentId>:<channel>:channel:<id>` (pase la clave completa).
- Los trabajos cron usan `cron:<job.id>`.
- Los hooks usan `hook:<uuid>` a menos que se establezca explícitamente.
- Las sesiones de nodo usan `node-<nodeId>` a menos que se establezca explícitamente.

`global` y `unknown` son valores reservados y nunca se listan. Si `session.scope = "global"`, lo aliamos a `main` para todas las herramientas, de modo que los llamadores nunca vean `global`.

## sessions_list

Lista sesiones como un arreglo de filas.

Parámetros:

- filtro `kinds?: string[]`: cualquiera de `"main" | "group" | "cron" | "hook" | "node" | "other"`
- `limit?: number` máximo de filas (predeterminado: valor del servidor, límite p. ej. 200)
- `activeMinutes?: number` solo sesiones actualizadas dentro de N minutos
- `messageLimit?: number` 0 = sin mensajes (predeterminado 0); >0 = incluir los últimos N mensajes

Comportamiento:

- `messageLimit > 0` obtiene `chat.history` por sesión e incluye los últimos N mensajes.
- Los resultados de herramientas se filtran en la salida de la lista; use `sessions_history` para mensajes de herramientas.
- Cuando se ejecuta en una sesión de agente **en sandbox**, las herramientas de sesión se configuran de forma predeterminada con **visibilidad solo de las sesiones generadas** (ver abajo).

Forma de fila (JSON):

- `key`: clave de sesión (string)
- `kind`: `main | group | cron | hook | node | other`
- `channel`: `whatsapp | telegram | discord | signal | imessage | webchat | internal | unknown`
- `displayName` (etiqueta de visualización del grupo si está disponible)
- `updatedAt` (ms)
- `sessionId`
- `model`, `contextTokens`, `totalTokens`
- `thinkingLevel`, `verboseLevel`, `systemSent`, `abortedLastRun`
- `sendPolicy` (anulación de sesión si está configurada)
- `lastChannel`, `lastTo`
- `deliveryContext` (`{ channel, to, accountId }` normalizado cuando está disponible)
- `transcriptPath` (ruta de mejor esfuerzo derivada del directorio de almacenamiento + sessionId)
- `messages?` (solo cuando `messageLimit > 0`)

## sessions_history

Obtiene la transcripción de una sesión.

Parámetros:

- `sessionKey` (obligatorio; acepta la clave de sesión o `sessionId` de `sessions_list`)
- `limit?: number` máximo de mensajes (el servidor aplica límites)
- `includeTools?: boolean` (predeterminado false)

Comportamiento:

- `includeTools=false` filtra mensajes `role: "toolResult"`.
- Devuelve un arreglo de mensajes en el formato de transcripción sin procesar.
- Cuando se proporciona un `sessionId`, OpenClaw lo resuelve a la clave de sesión correspondiente (error si faltan ids).

## sessions_send

Envía un mensaje a otra sesión.

Parámetros:

- `sessionKey` (obligatorio; acepta la clave de sesión o `sessionId` de `sessions_list`)
- `message` (obligatorio)
- `timeoutSeconds?: number` (predeterminado >0; 0 = enviar y olvidar)

Comportamiento:

- `timeoutSeconds = 0`: encola y devuelve `{ runId, status: "accepted" }`.
- `timeoutSeconds > 0`: espera hasta N segundos a que finalice y luego devuelve `{ runId, status: "ok", reply }`.
- Si la espera expira: `{ runId, status: "timeout", error }`. La ejecución continúa; llame a `sessions_history` más tarde.
- Si la ejecución falla: `{ runId, status: "error", error }`.
- Los anuncios de entrega se ejecutan después de que finaliza la ejecución principal y son de mejor esfuerzo; `status: "ok"` no garantiza que el anuncio se haya entregado.
- Espera a través del `agent.wait` del Gateway (del lado del servidor) para que las reconexiones no interrumpan la espera.
- Se inyecta el contexto de mensajes de agente a agente para la ejecución principal.
- Después de que finaliza la ejecución principal, OpenClaw ejecuta un **bucle de respuesta**:
  - La ronda 2+ alterna entre el agente solicitante y el agente destino.
  - Responda exactamente `REPLY_SKIP` para detener el ping‑pong.
  - El máximo de turnos es `session.agentToAgent.maxPingPongTurns` (0–5, predeterminado 5).
- Una vez que termina el bucle, OpenClaw ejecuta el **paso de anuncio de agente a agente** (solo el agente destino):
  - Responda exactamente `ANNOUNCE_SKIP` para permanecer en silencio.
  - Cualquier otra respuesta se envía al canal de destino.
  - El paso de anuncio incluye la solicitud original + la respuesta de la ronda 1 + la última respuesta del ping‑pong.

## Campo Channel

- Para grupos, `channel` es el canal registrado en la entrada de la sesión.
- Para chats directos, `channel` se asigna desde `lastChannel`.
- Para cron/hook/nodo, `channel` es `internal`.
- Si falta, `channel` es `unknown`.

## Seguridad / Política de envío

Bloqueo basado en políticas por canal/tipo de chat (no por id de sesión).

```json
{
  "session": {
    "sendPolicy": {
      "rules": [
        {
          "match": { "channel": "discord", "chatType": "group" },
          "action": "deny"
        }
      ],
      "default": "allow"
    }
  }
}
```

Anulación en tiempo de ejecución (por entrada de sesión):

- `sendPolicy: "allow" | "deny"` (sin configurar = hereda la configuración)
- Configurable mediante `sessions.patch` o `/send on|off|inherit` solo para el propietario (mensaje independiente).

Puntos de aplicación:

- `chat.send` / `agent` (Gateway)
- lógica de entrega de respuestas automáticas

## sessions_spawn

Genera una ejecución de sub‑agente en una sesión aislada y anuncia el resultado de vuelta al canal de chat del solicitante.

Parámetros:

- `task` (obligatorio)
- `label?` (opcional; usado para registros/UI)
- `agentId?` (opcional; generar bajo otro id de agente si está permitido)
- `model?` (opcional; anula el modelo del sub‑agente; valores inválidos generan error)
- `runTimeoutSeconds?` (predeterminado 0; cuando se establece, aborta la ejecución del sub‑agente después de N segundos)
- `cleanup?` (`delete|keep`, predeterminado `keep`)

Lista de permitidos:

- `agents.list[].subagents.allowAgents`: lista de ids de agentes permitidos mediante `agentId` (`["*"]` para permitir cualquiera). Predeterminado: solo el agente solicitante.

Descubrimiento:

- Use `agents_list` para descubrir qué ids de agentes están permitidos para `sessions_spawn`.

Comportamiento:

- Inicia una nueva sesión `agent:<agentId>:subagent:<uuid>` con `deliver: false`.
- Los sub‑agentes usan de forma predeterminada el conjunto completo de herramientas **menos las herramientas de sesión** (configurable mediante `tools.subagents.tools`).
- Los sub‑agentes no pueden llamar a `sessions_spawn` (no se permite generar sub‑agentes desde sub‑agentes).
- Siempre no bloqueante: devuelve `{ status: "accepted", runId, childSessionKey }` inmediatamente.
- Tras la finalización, OpenClaw ejecuta un **paso de anuncio** del sub‑agente y publica el resultado en el canal de chat del solicitante.
- Responda exactamente `ANNOUNCE_SKIP` durante el paso de anuncio para permanecer en silencio.
- Las respuestas de anuncio se normalizan a `Status`/`Result`/`Notes`; `Status` proviene del resultado en tiempo de ejecución (no del texto del modelo).
- Las sesiones de sub‑agente se archivan automáticamente después de `agents.defaults.subagents.archiveAfterMinutes` (predeterminado: 60).
- Las respuestas de anuncio incluyen una línea de estadísticas (tiempo de ejecución, tokens, sessionKey/sessionId, ruta de la transcripción y costo opcional).

## Visibilidad de sesiones en sandbox

Las sesiones en sandbox pueden usar herramientas de sesión, pero de forma predeterminada solo ven las sesiones que generaron mediante `sessions_spawn`.

Configuración:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        // default: "spawned"
        sessionToolsVisibility: "spawned", // or "all"
      },
    },
  },
}
```
