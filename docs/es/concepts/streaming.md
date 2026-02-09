---
summary: "Comportamiento de streaming + fragmentación (respuestas por bloques, streaming de borradores, límites)"
read_when:
  - Explicar cómo funciona el streaming o la fragmentación en los canales
  - Cambiar el streaming por bloques o el comportamiento de fragmentación por canal
  - Depurar respuestas por bloques duplicadas/anticipadas o streaming de borradores
title: "Streaming y fragmentación"
---

# Streaming + fragmentación

OpenClaw tiene dos capas de “streaming” separadas:

- **Streaming por bloques (canales):** emite **bloques** completados a medida que el asistente escribe. Estos son mensajes normales del canal (no deltas de tokens).
- **Streaming tipo token (solo Telegram):** actualiza una **burbuja de borrador** con texto parcial mientras se genera; el mensaje final se envía al final.

Hoy **no existe streaming real de tokens** hacia mensajes de canales externos. El streaming de borradores de Telegram es la única superficie de streaming parcial.

## Streaming por bloques (mensajes del canal)

El streaming por bloques envía la salida del asistente en fragmentos gruesos a medida que se vuelve disponible.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Leyenda:

- `text_delta/events`: eventos de stream del modelo (pueden ser escasos para modelos sin streaming).
- `chunker`: `EmbeddedBlockChunker` aplicando límites mínimo/máximo + preferencia de corte.
- `channel send`: mensajes salientes reales (respuestas por bloques).

**Controles:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (desactivado por defecto).
- Anulaciones por canal: `*.blockStreaming` (y variantes por cuenta) para forzar `"on"`/`"off"` por canal.
- `agents.defaults.blockStreamingBreak`: `"text_end"` o `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (fusionar bloques en streaming antes de enviar).
- Límite duro del canal: `*.textChunkLimit` (p. ej., `channels.whatsapp.textChunkLimit`).
- Modo de fragmentación del canal: `*.chunkMode` (`length` por defecto, `newline` divide en líneas en blanco (límites de párrafo) antes de fragmentar por longitud).
- Límite suave de Discord: `channels.discord.maxLinesPerMessage` (predeterminado 17) divide respuestas altas para evitar recortes en la UI.

**Semántica de límites:**

- `text_end`: emite bloques de stream tan pronto como el fragmentador emite; vacía en cada `text_end`.
- `message_end`: espera a que termine el mensaje del asistente y luego vacía la salida en búfer.

`message_end` sigue usando el fragmentador si el texto en búfer supera `maxChars`, por lo que puede emitir múltiples fragmentos al final.

## Algoritmo de fragmentación (límites bajo/alto)

La fragmentación por bloques se implementa mediante `EmbeddedBlockChunker`:

- **Límite bajo:** no emitir hasta que el búfer >= `minChars` (a menos que se fuerce).
- **Límite alto:** preferir cortes antes de `maxChars`; si se fuerza, cortar en `maxChars`.
- **Preferencia de corte:** `paragraph` → `newline` → `sentence` → `whitespace` → corte duro.
- **Vallas de código:** nunca dividir dentro de vallas; cuando se fuerza en `maxChars`, cerrar y reabrir la valla para mantener Markdown válido.

`maxChars` se limita al `textChunkLimit` del canal, por lo que no puede exceder los límites por canal.

## Coalescencia (fusionar bloques en streaming)

Cuando el streaming por bloques está habilitado, OpenClaw puede **fusionar fragmentos de bloques consecutivos**
antes de enviarlos. Esto reduce el “spam de una sola línea” mientras sigue proporcionando
salida progresiva.

- La coalescencia espera **intervalos de inactividad** (`idleMs`) antes de vaciar.
- Los búferes tienen un tope de `maxChars` y se vaciarán si lo superan.
- `minChars` evita que se envíen fragmentos diminutos hasta que se acumule suficiente texto
  (el vaciado final siempre envía el texto restante).
- El conector se deriva de `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → espacio).
- Hay anulaciones por canal disponibles mediante `*.blockStreamingCoalesce` (incluidas configuraciones por cuenta).
- El `minChars` de coalescencia predeterminado se incrementa a 1500 para Signal/Slack/Discord a menos que se anule.

## Ritmo humano entre bloques

Cuando el streaming por bloques está habilitado, puede agregar una **pausa aleatoria** entre
respuestas por bloques (después del primer bloque). Esto hace que las respuestas con múltiples burbujas
se sientan más naturales.

- Configuración: `agents.defaults.humanDelay` (anular por agente mediante `agents.list[].humanDelay`).
- Modos: `off` (predeterminado), `natural` (800–2500 ms), `custom` (`minMs`/`maxMs`).
- Se aplica solo a **respuestas por bloques**, no a respuestas finales ni a resúmenes de herramientas.

## “Transmitir fragmentos o todo”

Esto se asigna a:

- **Transmitir fragmentos:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emitir a medida que avanza). Los canales que no son Telegram también necesitan `*.blockStreaming: true`.
- **Transmitir todo al final:** `blockStreamingBreak: "message_end"` (vaciar una vez, posiblemente en múltiples fragmentos si es muy largo).
- **Sin streaming por bloques:** `blockStreamingDefault: "off"` (solo respuesta final).

**Nota del canal:** Para canales que no son Telegram, el streaming por bloques está **desactivado a menos que**
`*.blockStreaming` se establezca explícitamente en `true`. Telegram puede transmitir borradores
(`channels.telegram.streamMode`) sin respuestas por bloques.

Recordatorio de ubicación de configuración: los valores predeterminados de `blockStreaming*` viven bajo
`agents.defaults`, no en la configuración raíz.

## Streaming de borradores de Telegram (tipo token)

Telegram es el único canal con streaming de borradores:

- Usa la API de Bot `sendMessageDraft` en **chats privados con temas**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: actualizaciones del borrador con el texto más reciente del stream.
  - `block`: actualizaciones del borrador en bloques fragmentados (mismas reglas del fragmentador).
  - `off`: sin streaming de borradores.
- Configuración de fragmentos del borrador (solo para `streamMode: "block"`): `channels.telegram.draftChunk` (valores predeterminados: `minChars: 200`, `maxChars: 800`).
- El streaming de borradores es independiente del streaming por bloques; las respuestas por bloques están desactivadas por defecto y solo se habilitan mediante `*.blockStreaming: true` en canales que no son Telegram.
- La respuesta final sigue siendo un mensaje normal.
- `/reasoning stream` escribe el razonamiento en la burbuja de borrador (solo Telegram).

Cuando el streaming de borradores está activo, OpenClaw desactiva el streaming por bloques para esa respuesta para evitar doble streaming.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Leyenda:

- `sendMessageDraft`: burbuja de borrador de Telegram (no es un mensaje real).
- `final reply`: envío normal de mensaje de Telegram.
