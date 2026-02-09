---
summary: "Plan: Agregar el endpoint OpenResponses /v1/responses y deprecar Chat Completions de forma limpia"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Plan del Gateway OpenResponses"
---

# Plan de Integración del Gateway OpenResponses

## Contexto

OpenClaw Gateway actualmente expone un endpoint mínimo de Chat Completions compatible con OpenAI en
`/v1/chat/completions` (ver [OpenAI Chat Completions](/gateway/openai-http-api)).

Open Responses es un estándar abierto de inferencia basado en la API OpenAI Responses. Está diseñado
para flujos de trabajo agentic y utiliza entradas basadas en ítems además de eventos de streaming semánticos. La especificación OpenResponses
define `/v1/responses`, no `/v1/chat/completions`.

## Objetivos

- Agregar un endpoint `/v1/responses` que se adhiera a la semántica de OpenResponses.
- Mantener Chat Completions como una capa de compatibilidad que sea fácil de deshabilitar y eventualmente eliminar.
- Estandarizar la validación y el parsing con esquemas aislados y reutilizables.

## No objetivos

- Paridad completa de funcionalidades de OpenResponses en la primera pasada (imágenes, archivos, herramientas alojadas).
- Reemplazar la lógica interna de ejecución de agentes o la orquestación de herramientas.
- Cambiar el comportamiento existente de `/v1/chat/completions` durante la primera fase.

## Resumen de Investigación

Fuentes: OpenAPI de OpenResponses, sitio de especificación de OpenResponses y la publicación del blog de Hugging Face.

Puntos clave extraídos:

- `POST /v1/responses` acepta campos `CreateResponseBody` como `model`, `input` (string o
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` y
  `max_tool_calls`.
- `ItemParam` es una unión discriminada de:
  - ítems `message` con roles `system`, `developer`, `user`, `assistant`
  - `function_call` y `function_call_output`
  - `reasoning`
  - `item_reference`
- Las respuestas exitosas devuelven un `ResponseResource` con ítems `object: "response"`, `status` y
  `output`.
- El streaming utiliza eventos semánticos como:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- La especificación requiere:
  - `Content-Type: text/event-stream`
  - `event:` debe coincidir con el campo JSON `type`
  - el evento terminal debe ser el literal `[DONE]`
- Los ítems de razonamiento pueden exponer `content`, `encrypted_content` y `summary`.
- Los ejemplos de HF incluyen `OpenResponses-Version: latest` en las solicitudes (encabezado opcional).

## Arquitectura Propuesta

- Agregar `src/gateway/open-responses.schema.ts` que contenga solo esquemas Zod (sin imports del gateway).
- Agregar `src/gateway/openresponses-http.ts` (o `open-responses-http.ts`) para `/v1/responses`.
- Mantener `src/gateway/openai-http.ts` intacto como un adaptador de compatibilidad heredado.
- Agregar configuración `gateway.http.endpoints.responses.enabled` (predeterminado `false`).
- Mantener `gateway.http.endpoints.chatCompletions.enabled` independiente; permitir que ambos endpoints se
  alternen por separado.
- Emitir una advertencia de inicio cuando Chat Completions esté habilitado para señalar su estado heredado.

## Ruta de Deprecación para Chat Completions

- Mantener límites estrictos de módulos: no compartir tipos de esquemas entre responses y chat completions.
- Hacer que Chat Completions sea opt-in por configuración para que pueda deshabilitarse sin cambios de código.
- Actualizar la documentación para etiquetar Chat Completions como heredado una vez que `/v1/responses` sea estable.
- Paso futuro opcional: mapear las solicitudes de Chat Completions al handler de Responses para una ruta de eliminación
  más simple.

## Subconjunto de Soporte de la Fase 1

- Aceptar `input` como string o `ItemParam[]` con roles de mensajes y `function_call_output`.
- Extraer mensajes de sistema y desarrollador en `extraSystemPrompt`.
- Usar el `user` o `function_call_output` más reciente como el mensaje actual para ejecuciones de agentes.
- Rechazar partes de contenido no compatibles (imagen/archivo) con `invalid_request_error`.
- Devolver un único mensaje del asistente con contenido `output_text`.
- Devolver `usage` con valores en cero hasta que el conteo de tokens esté conectado.

## Estrategia de Validación (Sin SDK)

- Implementar esquemas Zod para el subconjunto soportado de:
  - `CreateResponseBody`
  - `ItemParam` + uniones de partes de contenido de mensajes
  - `ResponseResource`
  - Formas de eventos de streaming usadas por el gateway
- Mantener los esquemas en un único módulo aislado para evitar desviaciones y permitir futura generación de código.

## Implementación de Streaming (Fase 1)

- Líneas SSE con ambos `event:` y `data:`.
- Secuencia requerida (mínimo viable):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (repetir según sea necesario)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Pruebas y Plan de Verificación

- Agregar cobertura e2e para `/v1/responses`:
  - Autenticación requerida
  - Forma de respuesta no streaming
  - Orden de eventos de streaming y `[DONE]`
  - Enrutamiento de sesión con encabezados y `user`
- Mantener `src/gateway/openai-http.e2e.test.ts` sin cambios.
- Manual: curl a `/v1/responses` con `stream: true` y verificar el orden de eventos y el
  `[DONE]` terminal.

## Actualizaciones de Documentación (Seguimiento)

- Agregar una nueva página de documentación para el uso y ejemplos de `/v1/responses`.
- Actualizar `/gateway/openai-http-api` con una nota de heredado y un enlace a `/v1/responses`.
