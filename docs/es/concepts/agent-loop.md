---
summary: "Ciclo de vida del bucle del agente, streams y semántica de espera"
read_when:
  - Necesita un recorrido exacto del bucle del agente o de los eventos del ciclo de vida
title: "Bucle del agente"
---

# Bucle del agente (OpenClaw)

Un bucle agentic es la ejecución “real” completa de un agente: ingesta → ensamblaje de contexto → inferencia del modelo →
ejecución de herramientas → streaming de respuestas → persistencia. Es la ruta autorizada que convierte un mensaje
en acciones y una respuesta final, manteniendo consistente el estado de la sesión.

En OpenClaw, un bucle es una única ejecución serializada por sesión que emite eventos de ciclo de vida y de stream
mientras el modelo razona, llama herramientas y transmite la salida. Este documento explica cómo ese bucle auténtico
está conectado de extremo a extremo.

## Puntos de entrada

- RPC del Gateway: `agent` y `agent.wait`.
- CLI: comando `agent`.

## Cómo funciona (alto nivel)

1. El RPC `agent` valida parámetros, resuelve la sesión (sessionKey/sessionId), persiste metadatos de la sesión y devuelve `{ runId, acceptedAt }` de inmediato.
2. `agentCommand` ejecuta el agente:
   - resuelve el modelo y los valores predeterminados de thinking/verbose
   - carga el snapshot de Skills
   - llama a `runEmbeddedPiAgent` (runtime de pi-agent-core)
   - emite **fin/error del ciclo de vida** si el bucle embebido no emite uno
3. `runEmbeddedPiAgent`:
   - serializa ejecuciones mediante colas por sesión + globales
   - resuelve el modelo + perfil de autenticación y construye la sesión de pi
   - se suscribe a eventos de pi y transmite deltas del asistente/herramientas
   - aplica el timeout → aborta la ejecución si se excede
   - devuelve payloads + metadatos de uso
4. `subscribeEmbeddedPiSession` conecta eventos de pi-agent-core al stream `agent` de OpenClaw:
   - eventos de herramientas => `stream: "tool"`
   - deltas del asistente => `stream: "assistant"`
   - eventos de ciclo de vida => `stream: "lifecycle"` (`phase: "start" | "end" | "error"`)
5. `agent.wait` usa `waitForAgentJob`:
   - espera **fin/error del ciclo de vida** para `runId`
   - devuelve `{ status: ok|error|timeout, startedAt, endedAt, error? }`

## Cola + concurrencia

- Las ejecuciones se serializan por clave de sesión (carril de sesión) y opcionalmente a través de un carril global.
- Esto evita condiciones de carrera de herramientas/sesión y mantiene consistente el historial de la sesión.
- Los canales de mensajería pueden elegir modos de cola (collect/steer/followup) que alimentan este sistema de carriles.
  Vea [Command Queue](/concepts/queue).

## Preparación de sesión + espacio de trabajo

- El espacio de trabajo se resuelve y crea; las ejecuciones en sandbox pueden redirigir a una raíz de espacio de trabajo de sandbox.
- Las Skills se cargan (o se reutilizan desde un snapshot) y se inyectan en el entorno y el prompt.
- Los archivos de arranque/contexto se resuelven y se inyectan en el informe del prompt del sistema.
- Se adquiere un bloqueo de escritura de la sesión; `SessionManager` se abre y prepara antes del streaming.

## Ensamblaje del prompt + prompt del sistema

- El prompt del sistema se construye a partir del prompt base de OpenClaw, el prompt de Skills, el contexto de arranque y las anulaciones por ejecución.
- Se aplican los límites específicos del modelo y los tokens de reserva para compactación.
- Vea [System prompt](/concepts/system-prompt) para lo que ve el modelo.

## Puntos de enganche (donde puede interceptar)

OpenClaw tiene dos sistemas de hooks:

- **Hooks internos** (hooks del Gateway): scripts dirigidos por eventos para comandos y eventos del ciclo de vida.
- **Hooks de plugins**: puntos de extensión dentro del ciclo de vida del agente/herramientas y del pipeline del gateway.

### Hooks internos (hooks del Gateway)

- **`agent:bootstrap`**: se ejecuta mientras se construyen los archivos de arranque antes de que se finalice el prompt del sistema.
  Úselo para agregar/eliminar archivos de contexto de arranque.
- **Hooks de comandos**: `/new`, `/reset`, `/stop` y otros eventos de comandos (ver documento de Hooks).

Vea [Hooks](/automation/hooks) para la configuración y ejemplos.

### Hooks de plugins (ciclo de vida del agente + gateway)

Estos se ejecutan dentro del bucle del agente o del pipeline del gateway:

- **`before_agent_start`**: inyecta contexto o anula el prompt del sistema antes de que inicie la ejecución.
- **`agent_end`**: inspecciona la lista final de mensajes y los metadatos de la ejecución después de la finalización.
- **`before_compaction` / `after_compaction`**: observa o anota ciclos de compactación.
- **`before_tool_call` / `after_tool_call`**: intercepta parámetros/resultados de herramientas.
- **`tool_result_persist`**: transforma sincrónicamente los resultados de herramientas antes de que se escriban en la transcripción de la sesión.
- **`message_received` / `message_sending` / `message_sent`**: hooks de mensajes entrantes + salientes.
- **`session_start` / `session_end`**: límites del ciclo de vida de la sesión.
- **`gateway_start` / `gateway_stop`**: eventos del ciclo de vida del gateway.

Vea [Plugins](/tools/plugin#plugin-hooks) para la API de hooks y los detalles de registro.

## Streaming + respuestas parciales

- Los deltas del asistente se transmiten desde pi-agent-core y se emiten como eventos `assistant`.
- El streaming por bloques puede emitir respuestas parciales ya sea en `text_end` o `message_end`.
- El streaming de razonamiento puede emitirse como un stream separado o como respuestas por bloques.
- Vea [Streaming](/concepts/streaming) para el comportamiento de fragmentación y respuestas por bloques.

## Ejecución de herramientas + herramientas de mensajería

- Los eventos de inicio/actualización/fin de herramientas se emiten en el stream `tool`.
- Los resultados de herramientas se sanitizan por tamaño y payloads de imagen antes de registrar/emitar.
- Los envíos de herramientas de mensajería se rastrean para suprimir confirmaciones duplicadas del asistente.

## Modelado de respuestas + supresión

- Los payloads finales se ensamblan a partir de:
  - texto del asistente (y razonamiento opcional)
  - resúmenes de herramientas en línea (cuando verbose + permitido)
  - texto de error del asistente cuando el modelo falla
- `NO_REPLY` se trata como un token silencioso y se filtra de los payloads salientes.
- Los duplicados de herramientas de mensajería se eliminan de la lista final de payloads.
- Si no quedan payloads renderizables y una herramienta falló, se emite una respuesta de error de herramienta de respaldo
  (a menos que una herramienta de mensajería ya haya enviado una respuesta visible para el usuario).

## Compactación + reintentos

- La compactación automática emite eventos de stream `compaction` y puede disparar un reintento.
- En el reintento, los buffers en memoria y los resúmenes de herramientas se restablecen para evitar salida duplicada.
- Vea [Compaction](/concepts/compaction) para el pipeline de compactación.

## Streams de eventos (hoy)

- `lifecycle`: emitido por `subscribeEmbeddedPiSession` (y como respaldo por `agentCommand`)
- `assistant`: deltas transmitidos desde pi-agent-core
- `tool`: eventos de herramientas transmitidos desde pi-agent-core

## Manejo del canal de chat

- Los deltas del asistente se almacenan en mensajes de chat `delta`.
- Se emite un chat `final` en **fin/error del ciclo de vida**.

## Timeouts

- Valor predeterminado de `agent.wait`: 30 s (solo la espera). El parámetro `timeoutMs` lo anula.
- Runtime del agente: valor predeterminado de `agents.defaults.timeoutSeconds` 600 s; aplicado en el temporizador de aborto `runEmbeddedPiAgent`.

## Dónde las cosas pueden terminar antes

- Timeout del agente (aborto)
- AbortSignal (cancelación)
- Desconexión del Gateway o timeout del RPC
- Timeout de `agent.wait` (solo espera, no detiene al agente)
