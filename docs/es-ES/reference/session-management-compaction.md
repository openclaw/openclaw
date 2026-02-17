---
summary: "Inmersión profunda: almacén de sesiones + transcripciones, ciclo de vida e internos de (auto)compactación"
read_when:
  - Necesitas depurar ids de sesión, JSONL de transcripción o campos de sessions.json
  - Estás cambiando comportamiento de auto-compactación o agregando tareas previas a la compactación
  - Quieres implementar vaciados de memoria o turnos de sistema silenciosos
title: "Inmersión Profunda en Gestión de Sesiones"
---

# Gestión de Sesiones y Compactación (Inmersión Profunda)

Este documento explica cómo OpenClaw gestiona sesiones de extremo a extremo:

- **Enrutamiento de sesión** (cómo los mensajes entrantes mapean a un `sessionKey`)
- **Almacén de sesión** (`sessions.json`) y qué rastrea
- **Persistencia de transcripción** (`*.jsonl`) y su estructura
- **Higiene de transcripción** (correcciones específicas del proveedor antes de ejecuciones)
- **Límites de contexto** (ventana de contexto vs tokens rastreados)
- **Compactación** (compactación manual + auto-compactación) y dónde enganchar trabajo pre-compactación
- **Mantenimiento silencioso** (ej. escrituras de memoria que no deben producir salida visible para el usuario)

Si deseas una visión general de nivel superior primero, comienza con:

- [/concepts/session](/es-ES/concepts/session)
- [/concepts/compaction](/es-ES/concepts/compaction)
- [/concepts/session-pruning](/es-ES/concepts/session-pruning)
- [/reference/transcript-hygiene](/es-ES/reference/transcript-hygiene)

---

## Fuente de verdad: el Gateway

OpenClaw está diseñado alrededor de un único **proceso Gateway** que posee el estado de sesión.

- Las UIs (app de macOS, UI de Control web, TUI) deben consultar al Gateway para listas de sesiones y conteos de tokens.
- En modo remoto, los archivos de sesión están en el host remoto; "verificar tus archivos Mac locales" no reflejará lo que el Gateway está usando.

---

## Dos capas de persistencia

OpenClaw persiste sesiones en dos capas:

1. **Almacén de sesión (`sessions.json`)**
   - Mapa clave/valor: `sessionKey -> SessionEntry`
   - Pequeño, mutable, seguro para editar (o eliminar entradas)
   - Rastrea metadatos de sesión (id de sesión actual, última actividad, toggles, contadores de tokens, etc.)

2. **Transcripción (`<sessionId>.jsonl`)**
   - Transcripción solo de agregar con estructura de árbol (entradas tienen `id` + `parentId`)
   - Almacena la conversación real + llamadas a herramientas + resúmenes de compactación
   - Usado para reconstruir el contexto del modelo para turnos futuros

---

## Ubicaciones en disco

Por agente, en el host Gateway:

- Almacén: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Transcripciones: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Sesiones de tema de Telegram: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw resuelve estos mediante `src/config/sessions.ts`.

---

## Claves de sesión (`sessionKey`)

Un `sessionKey` identifica _en qué cubeta de conversación_ estás (enrutamiento + aislamiento).

Patrones comunes:

- Chat principal/directo (por agente): `agent:<agentId>:<mainKey>` (predeterminado `main`)
- Grupo: `agent:<agentId>:<channel>:group:<id>`
- Sala/canal (Discord/Slack): `agent:<agentId>:<channel>:channel:<id>` o `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>` (a menos que se anule)

Las reglas canónicas están documentadas en [/concepts/session](/es-ES/concepts/session).

---

## IDs de sesión (`sessionId`)

Cada `sessionKey` apunta a un `sessionId` actual (el archivo de transcripción que continúa la conversación).

Reglas generales:

- **Reset** (`/new`, `/reset`) crea un nuevo `sessionId` para ese `sessionKey`.
- **Reset diario** (predeterminado 4:00 AM hora local en el host gateway) crea un nuevo `sessionId` en el siguiente mensaje después del límite de reset.
- **Expiración por inactividad** (`session.reset.idleMinutes` o legacy `session.idleMinutes`) crea un nuevo `sessionId` cuando llega un mensaje después de la ventana de inactividad. Cuando se configuran diario + inactividad, gana el que expire primero.

Detalle de implementación: la decisión ocurre en `initSessionState()` en `src/auto-reply/reply/session.ts`.

---

## Esquema de almacén de sesión (`sessions.json`)

El tipo de valor del almacén es `SessionEntry` en `src/config/sessions.ts`.

Campos clave (no exhaustivo):

- `sessionId`: id de transcripción actual (el nombre de archivo se deriva de esto a menos que se configure `sessionFile`)
- `updatedAt`: marca de tiempo de última actividad
- `sessionFile`: anulación opcional de ruta de transcripción explícita
- `chatType`: `direct | group | room` (ayuda a UIs y política de envío)
- `provider`, `subject`, `room`, `space`, `displayName`: metadatos para etiquetado de grupo/canal
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy` (anulación por sesión)
- Selección de modelo:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- Contadores de tokens (mejor esfuerzo / dependiente del proveedor):
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: cuántas veces se completó la auto-compactación para esta clave de sesión
- `memoryFlushAt`: marca de tiempo del último vaciado de memoria pre-compactación
- `memoryFlushCompactionCount`: conteo de compactación cuando se ejecutó el último vaciado

El almacén es seguro para editar, pero el Gateway es la autoridad: puede reescribir o rehidratar entradas a medida que se ejecutan las sesiones.

---

## Estructura de transcripción (`*.jsonl`)

Las transcripciones son gestionadas por el `SessionManager` de `@mariozechner/pi-coding-agent`.

El archivo es JSONL:

- Primera línea: encabezado de sesión (`type: "session"`, incluye `id`, `cwd`, `timestamp`, `parentSession` opcional)
- Luego: entradas de sesión con `id` + `parentId` (árbol)

Tipos de entrada notables:

- `message`: mensajes de usuario/asistente/toolResult
- `custom_message`: mensajes inyectados por extensión que _entran_ en contexto de modelo (pueden ocultarse de la UI)
- `custom`: estado de extensión que _no_ entra en contexto de modelo
- `compaction`: resumen de compactación persistido con `firstKeptEntryId` y `tokensBefore`
- `branch_summary`: resumen persistido al navegar una rama de árbol

OpenClaw intencionalmente **no** "arregla" transcripciones; el Gateway usa `SessionManager` para leerlas/escribirlas.

---

## Ventanas de contexto vs tokens rastreados

Dos conceptos diferentes importan:

1. **Ventana de contexto del modelo**: límite duro por modelo (tokens visibles para el modelo)
2. **Contadores del almacén de sesión**: estadísticas continuas escritas en `sessions.json` (usado para /status y dashboards)

Si estás ajustando límites:

- La ventana de contexto viene del catálogo de modelos (y puede anularse mediante config).
- `contextTokens` en el almacén es un valor de estimación/reporte en tiempo de ejecución; no lo trates como garantía estricta.

Para más, ver [/token-use](/es-ES/reference/token-use).

---

## Compactación: qué es

La compactación resume conversación más antigua en una entrada de `compaction` persistida en la transcripción y mantiene mensajes recientes intactos.

Después de la compactación, los turnos futuros ven:

- El resumen de compactación
- Mensajes después de `firstKeptEntryId`

La compactación es **persistente** (a diferencia de la poda de sesión). Ver [/concepts/session-pruning](/es-ES/concepts/session-pruning).

---

## Cuándo ocurre la auto-compactación (runtime Pi)

En el agente Pi embebido, la auto-compactación se activa en dos casos:

1. **Recuperación de desbordamiento**: el modelo devuelve un error de desbordamiento de contexto → compactar → reintentar.
2. **Mantenimiento de umbral**: después de un turno exitoso, cuando:

`contextTokens > contextWindow - reserveTokens`

Donde:

- `contextWindow` es la ventana de contexto del modelo
- `reserveTokens` es espacio reservado para prompts + la siguiente salida del modelo

Estas son semánticas de runtime Pi (OpenClaw consume los eventos, pero Pi decide cuándo compactar).

---

## Configuración de compactación (`reserveTokens`, `keepRecentTokens`)

La configuración de compactación de Pi vive en configuración de Pi:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw también aplica un piso de seguridad para ejecuciones embebidas:

- Si `compaction.reserveTokens < reserveTokensFloor`, OpenClaw lo aumenta.
- Piso predeterminado es `20000` tokens.
- Establece `agents.defaults.compaction.reserveTokensFloor: 0` para deshabilitar el piso.
- Si ya es mayor, OpenClaw lo deja solo.

Por qué: dejar suficiente espacio para "mantenimiento" multi-turno (como escrituras de memoria) antes de que la compactación sea inevitable.

Implementación: `ensurePiCompactionReserveTokens()` en `src/agents/pi-settings.ts`
(llamado desde `src/agents/pi-embedded-runner.ts`).

---

## Superficies visibles para el usuario

Puedes observar la compactación y el estado de sesión mediante:

- `/status` (en cualquier sesión de chat)
- `openclaw status` (CLI)
- `openclaw sessions` / `sessions --json`
- Modo verbose: `🧹 Auto-compactación completa` + conteo de compactación

---

## Mantenimiento silencioso (`NO_REPLY`)

OpenClaw admite turnos "silenciosos" para tareas en segundo plano donde el usuario no debe ver salida intermedia.

Convención:

- El asistente comienza su salida con `NO_REPLY` para indicar "no entregar una respuesta al usuario".
- OpenClaw quita/suprime esto en la capa de entrega.

A partir de `2026.1.10`, OpenClaw también suprime **streaming de borrador/escritura** cuando un fragmento parcial comienza con `NO_REPLY`, así que las operaciones silenciosas no filtran salida parcial a mitad de turno.

---

## "Vaciado de memoria" pre-compactación (implementado)

Objetivo: antes de que ocurra la auto-compactación, ejecutar un turno agéntico silencioso que escriba
estado duradero a disco (ej. `memory/YYYY-MM-DD.md` en el espacio de trabajo del agente) para que la compactación no pueda
borrar contexto crítico.

OpenClaw usa el enfoque de **vaciado pre-umbral**:

1. Monitorear uso de contexto de sesión.
2. Cuando cruza un "umbral suave" (debajo del umbral de compactación de Pi), ejecutar una
   directiva silenciosa "escribir memoria ahora" al agente.
3. Usar `NO_REPLY` para que el usuario no vea nada.

Config (`agents.defaults.compaction.memoryFlush`):

- `enabled` (predeterminado: `true`)
- `softThresholdTokens` (predeterminado: `4000`)
- `prompt` (mensaje de usuario para el turno de vaciado)
- `systemPrompt` (prompt de sistema extra agregado para el turno de vaciado)

Notas:

- El prompt/system prompt predeterminados incluyen una pista de `NO_REPLY` para suprimir entrega.
- El vaciado se ejecuta una vez por ciclo de compactación (rastreado en `sessions.json`).
- El vaciado se ejecuta solo para sesiones Pi embebidas (backends CLI lo omiten).
- El vaciado se omite cuando el espacio de trabajo de sesión es de solo lectura (`workspaceAccess: "ro"` o `"none"`).
- Ver [Memoria](/es-ES/concepts/memory) para el diseño de archivos del espacio de trabajo y patrones de escritura.

Pi también expone un hook `session_before_compact` en la API de extensión, pero la
lógica de vaciado de OpenClaw vive en el lado Gateway hoy.

---

## Lista de verificación para solución de problemas

- ¿Clave de sesión incorrecta? Comienza con [/concepts/session](/es-ES/concepts/session) y confirma el `sessionKey` en `/status`.
- ¿Desajuste entre almacén y transcripción? Confirma el host Gateway y la ruta del almacén desde `openclaw status`.
- ¿Spam de compactación? Verifica:
  - ventana de contexto del modelo (demasiado pequeña)
  - configuración de compactación (`reserveTokens` demasiado alto para la ventana del modelo puede causar compactación más temprana)
  - hinchazón de resultados de herramientas: habilita/ajusta poda de sesión
- ¿Turnos silenciosos filtran? Confirma que la respuesta comienza con `NO_REPLY` (token exacto) y que estás en una compilación que incluye la corrección de supresión de streaming.
