---
summary: "Plan: Agregar endpoint OpenResponses /v1/responses y depreciar completamente chat completions limpiamente"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "Plan de Gateway OpenResponses"
---

# Plan de integración del Gateway OpenResponses

## Contexto

El Gateway de OpenClaw actualmente expone un endpoint mínimo compatible con OpenAI Chat Completions en `/v1/chat/completions` (ver [OpenAI Chat Completions](/es-ES/gateway/openai-http-api)).

Open Responses es un estándar de inferencia abierto basado en la API de Responses de OpenAI. Está diseñado para flujos de trabajo agénticos y utiliza entradas basadas en ítems más eventos de streaming semánticos. La especificación OpenResponses define `/v1/responses`, no `/v1/chat/completions`.

## Objetivos

- Agregar un endpoint `/v1/responses` que se adhiera a la semántica de OpenResponses.
- Mantener Chat Completions como una capa de compatibilidad que sea fácil de deshabilitar y eventualmente eliminar.
- Estandarizar la validación y el análisis con esquemas aislados y reutilizables.

## No objetivos

- Paridad completa de características de OpenResponses en el primer paso (imágenes, archivos, herramientas alojadas).
- Reemplazar la lógica de ejecución del agente interno o la orquestación de herramientas.
- Cambiar el comportamiento existente de `/v1/chat/completions` durante la primera fase.

## Resumen de investigación

Fuentes: OpenAPI de OpenResponses, sitio de especificación de OpenResponses y la publicación del blog de Hugging Face.

Puntos clave extraídos:

- `POST /v1/responses` acepta campos de `CreateResponseBody` como `model`, `input` (string o `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens` y `max_tool_calls`.
- `ItemParam` es una unión discriminada de:
  - ítems `message` con roles `system`, `developer`, `user`, `assistant`
  - `function_call` y `function_call_output`
  - `reasoning`
  - `item_reference`
- Las respuestas exitosas devuelven un `ResponseResource` con `object: "response"`, `status` e ítems `output`.
- El streaming usa eventos semánticos como:
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- La especificación requiere:
  - `Content-Type: text/event-stream`
  - `event:` debe coincidir con el campo JSON `type`
  - el evento terminal debe ser literal `[DONE]`
- Los ítems de razonamiento pueden exponer `content`, `encrypted_content` y `summary`.
- Los ejemplos de HF incluyen `OpenResponses-Version: latest` en solicitudes (encabezado opcional).

## Arquitectura propuesta

- Agregar `src/gateway/open-responses.schema.ts` conteniendo solo esquemas Zod (sin importaciones del Gateway).
- Agregar `src/gateway/openresponses-http.ts` (o `open-responses-http.ts`) para `/v1/responses`.
- Mantener `src/gateway/openai-http.ts` intacto como adaptador de compatibilidad heredado.
- Agregar config `gateway.http.endpoints.responses.enabled` (predeterminado `false`).
- Mantener `gateway.http.endpoints.chatCompletions.enabled` independiente; permitir que ambos endpoints se activen por separado.
- Emitir una advertencia de inicio cuando Chat Completions esté habilitado para señalar el estado heredado.

## Ruta de deprecación para Chat Completions

- Mantener límites estrictos de módulos: sin tipos de esquema compartidos entre responses y chat completions.
- Hacer que Chat Completions sea opt-in por configuración para que pueda deshabilitarse sin cambios de código.
- Actualizar documentación para etiquetar Chat Completions como heredado una vez que `/v1/responses` sea estable.
- Paso futuro opcional: mapear solicitudes de Chat Completions al manejador de Responses para una ruta de eliminación más simple.

## Subconjunto de soporte de Fase 1

- Aceptar `input` como string o `ItemParam[]` con roles de mensaje y `function_call_output`.
- Extraer mensajes system y developer en `extraSystemPrompt`.
- Usar el más reciente `user` o `function_call_output` como el mensaje actual para ejecuciones del agente.
- Rechazar partes de contenido no soportadas (image/file) con `invalid_request_error`.
- Devolver un único mensaje assistant con contenido `output_text`.
- Devolver `usage` con valores en cero hasta que se conecte la contabilidad de tokens.

## Estrategia de validación (sin SDK)

- Implementar esquemas Zod para el subconjunto soportado de:
  - `CreateResponseBody`
  - `ItemParam` + uniones de parte de contenido de mensaje
  - `ResponseResource`
  - Formas de evento de streaming usadas por el Gateway
- Mantener esquemas en un único módulo aislado para evitar desviación y permitir codegen futuro.

## Implementación de streaming (Fase 1)

- Líneas SSE con tanto `event:` como `data:`.
- Secuencia requerida (mínimo viable):
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (repetir según sea necesario)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Plan de pruebas y verificación

- Agregar cobertura e2e para `/v1/responses`:
  - Autenticación requerida
  - Forma de respuesta sin streaming
  - Orden de eventos de streaming y `[DONE]`
  - Enrutamiento de sesión con encabezados y `user`
- Mantener `src/gateway/openai-http.e2e.test.ts` sin cambios.
- Manual: curl a `/v1/responses` con `stream: true` y verificar orden de eventos y `[DONE]` terminal.

## Actualizaciones de documentación (seguimiento)

- Agregar una nueva página de documentación para uso y ejemplos de `/v1/responses`.
- Actualizar `/gateway/openai-http-api` con una nota de heredado y puntero a `/v1/responses`.
