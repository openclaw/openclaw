---
summary: "Referencia: reglas de sanitización y reparación de transcripciones específicas del proveedor"
read_when:
  - Estás depurando rechazos de solicitudes del proveedor relacionados con la forma de la transcripción
  - Estás cambiando la lógica de sanitización de transcripciones o reparación de llamadas de herramientas
  - Estás investigando desajustes de id de llamadas de herramientas entre proveedores
title: "Higiene de Transcripciones"
---

# Higiene de Transcripciones (Correcciones del Proveedor)

Este documento describe **correcciones específicas del proveedor** aplicadas a las transcripciones antes de una ejecución
(construcción del contexto del modelo). Estas son ajustes **en memoria** usados para satisfacer
requisitos estrictos del proveedor. Estos pasos de higiene **no** reescriben la transcripción JSONL almacenada
en disco; sin embargo, una pasada de reparación de archivo de sesión separada puede reescribir archivos JSONL malformados
descartando líneas inválidas antes de que se cargue la sesión. Cuando ocurre una reparación, el archivo original
se respalda junto al archivo de sesión.

El alcance incluye:

- Sanitización de id de llamadas de herramientas
- Validación de entrada de llamadas de herramientas
- Reparación de emparejamiento de resultados de herramientas
- Validación / ordenamiento de turnos
- Limpieza de firma de pensamiento
- Sanitización de payload de imágenes
- Etiquetado de proveniencia de entrada de usuario (para prompts enrutados entre sesiones)

Si necesitas detalles de almacenamiento de transcripciones, ver:

- [/es-ES/reference/session-management-compaction](/es-ES/reference/session-management-compaction)

---

## Dónde se ejecuta esto

Toda la higiene de transcripciones está centralizada en el runner embebido:

- Selección de política: `src/agents/transcript-policy.ts`
- Aplicación de sanitización/reparación: `sanitizeSessionHistory` en `src/agents/pi-embedded-runner/google.ts`

La política usa `provider`, `modelApi`, y `modelId` para decidir qué aplicar.

Separado de la higiene de transcripciones, los archivos de sesión se reparan (si es necesario) antes de cargar:

- `repairSessionFileIfNeeded` en `src/agents/session-file-repair.ts`
- Llamado desde `run/attempt.ts` y `compact.ts` (runner embebido)

---

## Regla global: sanitización de imágenes

Los payloads de imágenes siempre se sanitizan para prevenir rechazo del lado del proveedor debido a límites
de tamaño (reducir escala/recomprimir imágenes base64 de gran tamaño).

Implementación:

- `sanitizeSessionMessagesImages` en `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` en `src/agents/tool-images.ts`

---

## Regla global: llamadas de herramientas malformadas

Los bloques de llamadas de herramientas del asistente que faltan tanto `input` como `arguments` se descartan
antes de que se construya el contexto del modelo. Esto previene rechazos del proveedor de llamadas de herramientas
parcialmente persistidas (por ejemplo, después de una falla de límite de tasa).

Implementación:

- `sanitizeToolCallInputs` en `src/agents/session-transcript-repair.ts`
- Aplicado en `sanitizeSessionHistory` en `src/agents/pi-embedded-runner/google.ts`

---

## Regla global: proveniencia de entrada entre sesiones

Cuando un agente envía un prompt a otra sesión a través de `sessions_send` (incluyendo
pasos de respuesta/anuncio de agente a agente), OpenClaw persiste el turno de usuario creado con:

- `message.provenance.kind = "inter_session"`

Estos metadatos se escriben en el momento de agregar la transcripción y no cambian el rol
(`role: "user"` permanece para compatibilidad con el proveedor). Los lectores de transcripciones pueden usar
esto para evitar tratar prompts internos enrutados como instrucciones creadas por el usuario final.

Durante la reconstrucción del contexto, OpenClaw también antepone un breve marcador `[Inter-session message]`
a esos turnos de usuario en memoria para que el modelo pueda distinguirlos de
instrucciones externas del usuario final.

---

## Matriz de proveedores (comportamiento actual)

**OpenAI / OpenAI Codex**

- Solo sanitización de imágenes.
- Descartar firmas de razonamiento huérfanas (elementos de razonamiento independientes sin un bloque de contenido siguiente) para transcripciones de OpenAI Responses/Codex.
- Sin sanitización de id de llamadas de herramientas.
- Sin reparación de emparejamiento de resultados de herramientas.
- Sin validación de turnos o reordenamiento.
- Sin resultados de herramientas sintéticos.
- Sin eliminación de firma de pensamiento.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Sanitización de id de llamadas de herramientas: alfanumérico estricto.
- Reparación de emparejamiento de resultados de herramientas y resultados de herramientas sintéticos.
- Validación de turnos (alternancia de turnos estilo Gemini).
- Corrección de ordenamiento de turnos de Google (anteponer un bootstrap de usuario pequeño si el historial comienza con asistente).
- Antigravity Claude: normalizar firmas de pensamiento; descartar bloques de pensamiento sin firmar.

**Anthropic / Minimax (compatible con Anthropic)**

- Reparación de emparejamiento de resultados de herramientas y resultados de herramientas sintéticos.
- Validación de turnos (fusionar turnos de usuario consecutivos para satisfacer alternancia estricta).

**Mistral (incluida detección basada en model-id)**

- Sanitización de id de llamadas de herramientas: strict9 (alfanumérico longitud 9).

**OpenRouter Gemini**

- Limpieza de firma de pensamiento: eliminar valores `thought_signature` no base64 (mantener base64).

**Todo lo demás**

- Solo sanitización de imágenes.

---

## Comportamiento histórico (pre-2026.1.22)

Antes del lanzamiento 2026.1.22, OpenClaw aplicaba múltiples capas de higiene de transcripciones:

- Una **extensión de sanitización de transcripciones** se ejecutaba en cada construcción de contexto y podía:
  - Reparar emparejamiento de uso/resultado de herramientas.
  - Sanitizar ids de llamadas de herramientas (incluido un modo no estricto que preservaba `_`/`-`).
- El runner también realizaba sanitización específica del proveedor, lo que duplicaba el trabajo.
- Ocurrían mutaciones adicionales fuera de la política del proveedor, incluyendo:
  - Eliminar etiquetas `<final>` del texto del asistente antes de la persistencia.
  - Descartar turnos de error del asistente vacíos.
  - Recortar contenido del asistente después de llamadas de herramientas.

Esta complejidad causó regresiones entre proveedores (notablemente emparejamiento de `openai-responses`
`call_id|fc_id`). La limpieza 2026.1.22 eliminó la extensión, centralizó
la lógica en el runner, e hizo que OpenAI fuera **sin toques** más allá de la sanitización de imágenes.
