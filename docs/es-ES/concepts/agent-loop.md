---
summary: "Ciclo de vida del bucle de agente, streams y semántica de espera"
read_when:
  - Necesitas un recorrido exacto del bucle de agente o eventos del ciclo de vida
title: "Bucle de Agente"
---

# Bucle de Agente (OpenClaw)

Un bucle agéntico es la ejecución "real" completa de un agente: entrada → ensamblaje de contexto → inferencia del modelo →
ejecución de herramientas → respuestas en streaming → persistencia. Es el camino autoritativo que convierte un mensaje
en acciones y una respuesta final, mientras mantiene el estado de sesión consistente.

En OpenClaw, un bucle es una única ejecución serializada por sesión que emite eventos de ciclo de vida y stream
mientras el modelo piensa, llama herramientas y transmite salida. Este documento explica cómo ese bucle auténtico está
cableado de extremo a extremo.

## Puntos de entrada

- Gateway RPC: `agent` y `agent.wait`.
- CLI: comando `agent`.

## Cómo funciona (alto nivel)

1. El RPC `agent` valida parámetros, resuelve sesión (sessionKey/sessionId), persiste metadatos de sesión, devuelve `{ runId, acceptedAt }` inmediatamente.
2. `agentCommand` ejecuta el agente:
   - resuelve modelo + valores predeterminados de pensamiento/verboso
   - carga snapshot de habilidades
   - llama a `runEmbeddedPiAgent` (runtime de pi-agent-core)
   - emite **lifecycle end/error** si el bucle embebido no emite uno
3. `runEmbeddedPiAgent`:
   - serializa ejecuciones vía colas por sesión + globales
   - resuelve modelo + perfil de autenticación y construye la sesión pi
   - se suscribe a eventos pi y transmite deltas de asistente/herramienta
   - aplica timeout -> aborta ejecución si se excede
   - devuelve payloads + metadatos de uso
4. `subscribeEmbeddedPiSession` conecta eventos de pi-agent-core al stream `agent` de OpenClaw:
   - eventos de herramienta => `stream: "tool"`
   - deltas de asistente => `stream: "assistant"`
   - eventos de ciclo de vida => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` usa `waitForAgentJob`:
   - espera **lifecycle end/error** para `runId`
   - devuelve `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Encolamiento + concurrencia

- Las ejecuciones se serializan por clave de sesión (carril de sesión) y opcionalmente a través de un carril global.
- Esto previene carreras de herramientas/sesión y mantiene el historial de sesión consistente.
- Los canales de mensajería pueden elegir modos de cola (collect/steer/followup) que alimentan este sistema de carriles.
  Consulta [Cola de comandos](/es-ES/concepts/queue).

## Preparación de sesión + espacio de trabajo

- El espacio de trabajo se resuelve y crea; las ejecuciones en sandbox pueden redirigir a una raíz de espacio de trabajo sandbox.
- Las habilidades se cargan (o reutilizan desde un snapshot) e inyectan en env y prompt.
- Los archivos de bootstrap/contexto se resuelven e inyectan en el reporte del prompt del sistema.
- Se adquiere un bloqueo de escritura de sesión; `SessionManager` se abre y prepara antes del streaming.

## Ensamblaje de prompt + prompt del sistema

- El prompt del sistema se construye desde el prompt base de OpenClaw, prompt de habilidades, contexto de bootstrap y sobrescrituras por ejecución.
- Se aplican límites específicos del modelo y tokens de reserva de compactación.
- Consulta [Prompt del sistema](/es-ES/concepts/system-prompt) para lo que ve el modelo.

## Puntos de enganche (dónde puedes interceptar)

OpenClaw tiene dos sistemas de hooks:

- **Hooks internos** (hooks del Gateway): scripts manejados por eventos para comandos y eventos del ciclo de vida.
- **Hooks de plugin**: puntos de extensión dentro del ciclo de vida del agente/herramienta y pipeline del gateway.

### Hooks internos (hooks del Gateway)

- **`agent:bootstrap`**: se ejecuta mientras se construyen archivos de bootstrap antes de que el prompt del sistema se finalice.
  Usa esto para agregar/eliminar archivos de contexto de bootstrap.
- **Hooks de comando**: `/new`, `/reset`, `/stop`, y otros eventos de comando (consulta documentación de Hooks).

Consulta [Hooks](/es-ES/automation/hooks) para configuración y ejemplos.

### Hooks de plugin (ciclo de vida de agente + gateway)

Estos se ejecutan dentro del bucle de agente o pipeline del gateway:

- **`before_agent_start`**: inyecta contexto o sobrescribe el prompt del sistema antes de que comience la ejecución.
- **`agent_end`**: inspecciona la lista de mensajes final y metadatos de ejecución después de la finalización.
- **`before_compaction` / `after_compaction`**: observa o anota ciclos de compactación.
- **`before_tool_call` / `after_tool_call`**: intercepta parámetros/resultados de herramientas.
- **`tool_result_persist`**: transforma síncronamente resultados de herramientas antes de que se escriban en la transcripción de sesión.
- **`message_received` / `message_sending` / `message_sent`**: hooks de mensajes entrantes + salientes.
- **`session_start` / `session_end`**: límites del ciclo de vida de sesión.
- **`gateway_start` / `gateway_stop`**: eventos del ciclo de vida del gateway.

Consulta [Plugins](/es-ES/tools/plugin#plugin-hooks) para la API de hooks y detalles de registro.

## Streaming + respuestas parciales

- Los deltas del asistente se transmiten desde pi-agent-core y se emiten como eventos `assistant`.
- El streaming de bloques puede emitir respuestas parciales ya sea en `text_end` o `message_end`.
- El streaming de razonamiento puede emitirse como un stream separado o como respuestas de bloque.
- Consulta [Streaming](/es-ES/concepts/streaming) para comportamiento de fragmentación y respuesta de bloque.

## Ejecución de herramientas + herramientas de mensajería

- Los eventos de inicio/actualización/fin de herramienta se emiten en el stream `tool`.
- Los resultados de herramientas se sanitizan por tamaño y payloads de imagen antes de registrar/emitir.
- Los envíos de herramientas de mensajería se rastrean para suprimir confirmaciones de asistente duplicadas.

## Formación de respuesta + supresión

- Los payloads finales se ensamblan desde:
  - texto del asistente (y razonamiento opcional)
  - resúmenes de herramientas en línea (cuando verbose + permitido)
  - texto de error del asistente cuando el modelo falla
- `NO_REPLY` se trata como un token silencioso y se filtra de payloads salientes.
- Los duplicados de herramientas de mensajería se eliminan de la lista de payloads final.
- Si no quedan payloads renderizables y una herramienta tuvo error, se emite una respuesta de error de herramienta de fallback
  (a menos que una herramienta de mensajería ya haya enviado una respuesta visible para el usuario).

## Compactación + reintentos

- La auto-compactación emite eventos de stream `compaction` y puede activar un reintento.
- En reintento, los buffers en memoria y resúmenes de herramientas se resetean para evitar salida duplicada.
- Consulta [Compactación](/es-ES/concepts/compaction) para el pipeline de compactación.

## Streams de eventos (hoy)

- `lifecycle`: emitido por `subscribeEmbeddedPiSession` (y como fallback por `agentCommand`)
- `assistant`: deltas transmitidos desde pi-agent-core
- `tool`: eventos de herramienta transmitidos desde pi-agent-core

## Manejo de canal de chat

- Los deltas del asistente se almacenan en mensajes `delta` de chat.
- Un `final` de chat se emite en **lifecycle end/error**.

## Timeouts

- `agent.wait` predeterminado: 30s (solo la espera). El parámetro `timeoutMs` sobrescribe.
- Runtime del agente: `agents.defaults.timeoutSeconds` predeterminado 600s; aplicado en temporizador de aborto de `runEmbeddedPiAgent`.

## Dónde las cosas pueden terminar temprano

- Timeout del agente (abortar)
- AbortSignal (cancelar)
- Desconexión del Gateway o timeout de RPC
- Timeout de `agent.wait` (solo espera, no detiene al agente)
