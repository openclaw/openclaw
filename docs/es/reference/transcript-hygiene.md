---
summary: "Referencia: reglas de saneamiento y reparación de transcripciones específicas del proveedor"
read_when:
  - Usted está depurando rechazos de solicitudes del proveedor vinculados a la forma de la transcripción
  - Usted está cambiando el saneamiento de transcripciones o la lógica de reparación de llamadas a herramientas
  - Usted está investigando desajustes de id de llamadas a herramientas entre proveedores
title: "Higiene de transcripciones"
---

# Higiene de transcripciones (Correcciones por proveedor)

Este documento describe **correcciones específicas del proveedor** aplicadas a las transcripciones antes de una ejecución
(construcción del contexto del modelo). Estos son ajustes **en memoria** utilizados para satisfacer requisitos estrictos
del proveedor. Estos pasos de higiene **no** reescriben la transcripción JSONL almacenada en disco; sin embargo, un pase
separado de reparación del archivo de sesión puede reescribir archivos JSONL malformados eliminando líneas inválidas
antes de que se cargue la sesión. Cuando ocurre una reparación, el archivo original se respalda junto al archivo de sesión.

El alcance incluye:

- Saneamiento de id de llamadas a herramientas
- Validación de entradas de llamadas a herramientas
- Reparación del emparejamiento de resultados de herramientas
- Validación/ordenamiento de turnos
- Limpieza de firmas de pensamiento
- Saneamiento de cargas de imágenes

Si necesita detalles sobre el almacenamiento de transcripciones, consulte:

- [/reference/session-management-compaction](/reference/session-management-compaction)

---

## Dónde se ejecuta

Toda la higiene de transcripciones está centralizada en el runner integrado:

- Selección de políticas: `src/agents/transcript-policy.ts`
- Aplicación de saneamiento/reparación: `sanitizeSessionHistory` en `src/agents/pi-embedded-runner/google.ts`

La política usa `provider`, `modelApi` y `modelId` para decidir qué aplicar.

Separado de la higiene de transcripciones, los archivos de sesión se reparan (si es necesario) antes de cargarse:

- `repairSessionFileIfNeeded` en `src/agents/session-file-repair.ts`
- Llamado desde `run/attempt.ts` y `compact.ts` (runner integrado)

---

## Regla global: saneamiento de imágenes

Las cargas de imágenes siempre se saneán para prevenir rechazos del proveedor por límites
de tamaño (reducir escala/recomprimir imágenes base64 sobredimensionadas).

Implementación:

- `sanitizeSessionMessagesImages` en `src/agents/pi-embedded-helpers/images.ts`
- `sanitizeContentBlocksImages` en `src/agents/tool-images.ts`

---

## Regla global: llamadas a herramientas malformadas

Los bloques de llamadas a herramientas del asistente que carecen de ambos `input` y `arguments` se eliminan
antes de que se construya el contexto del modelo. Esto evita rechazos del proveedor por llamadas a herramientas
parcialmente persistidas (por ejemplo, después de un fallo por límite de velocidad).

Implementación:

- `sanitizeToolCallInputs` en `src/agents/session-transcript-repair.ts`
- Aplicado en `sanitizeSessionHistory` en `src/agents/pi-embedded-runner/google.ts`

---

## Matriz de proveedores (comportamiento actual)

**OpenAI / OpenAI Codex**

- Solo saneamiento de imágenes.
- Al cambiar el modelo a OpenAI Responses/Codex, eliminar firmas de razonamiento huérfanas (elementos de razonamiento independientes sin un bloque de contenido posterior).
- Sin saneamiento de id de llamadas a herramientas.
- Sin reparación del emparejamiento de resultados de herramientas.
- Sin validación ni reordenamiento de turnos.
- Sin resultados de herramientas sintéticos.
- Sin eliminación de firmas de pensamiento.

**Google (Generative AI / Gemini CLI / Antigravity)**

- Saneamiento de id de llamadas a herramientas: alfanumérico estricto.
- Reparación del emparejamiento de resultados de herramientas y resultados de herramientas sintéticos.
- Validación de turnos (alternancia de turnos al estilo Gemini).
- Corrección del orden de turnos de Google (anteponer un pequeño bootstrap de usuario si el historial comienza con el asistente).
- Antigravity Claude: normalizar firmas de pensamiento; eliminar bloques de pensamiento sin firma.

**Anthropic / Minimax (compatible con Anthropic)**

- Reparación del emparejamiento de resultados de herramientas y resultados de herramientas sintéticos.
- Validación de turnos (fusionar turnos consecutivos del usuario para cumplir la alternancia estricta).

**Mistral (incluida la detección basada en id de modelo)**

- Saneamiento de id de llamadas a herramientas: strict9 (alfanumérico de longitud 9).

**OpenRouter Gemini**

- Limpieza de firmas de pensamiento: eliminar valores `thought_signature` que no sean base64 (conservar base64).

**Todo lo demás**

- Solo saneamiento de imágenes.

---

## Comportamiento histórico (antes de 2026.1.22)

Antes de la versión 2026.1.22, OpenClaw aplicaba múltiples capas de higiene de transcripciones:

- Una **extensión de saneamiento de transcripciones** se ejecutaba en cada construcción de contexto y podía:
  - Reparar el emparejamiento de uso/resultado de herramientas.
  - Sanear id de llamadas a herramientas (incluido un modo no estricto que preservaba `_`/`-`).
- El runner también realizaba saneamiento específico del proveedor, lo que duplicaba trabajo.
- Ocurrían mutaciones adicionales fuera de la política del proveedor, incluidas:
  - Eliminar etiquetas `<final>` del texto del asistente antes de la persistencia.
  - Eliminar turnos de error del asistente vacíos.
  - Recortar el contenido del asistente después de llamadas a herramientas.

Esta complejidad causó regresiones entre proveedores (en particular el emparejamiento `openai-responses`
`call_id|fc_id`). La limpieza de 2026.1.22 eliminó la extensión, centralizó la
lógica en el runner e hizo que OpenAI fuera **sin intervención** más allá del saneamiento de imágenes.
