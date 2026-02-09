---
summary: "Exponer un endpoint HTTP /v1/responses compatible con OpenResponses desde el Gateway"
read_when:
  - Integrar clientes que hablan la API de OpenResponses
  - Quiere entradas basadas en ítems, llamadas a herramientas del cliente o eventos SSE
title: "API de OpenResponses"
---

# API de OpenResponses (HTTP)

El Gateway de OpenClaw puede servir un endpoint `POST /v1/responses` compatible con OpenResponses.

Este endpoint está **deshabilitado por defecto**. Habilítelo primero en la configuración.

- `POST /v1/responses`
- Mismo puerto que el Gateway (multiplexación WS + HTTP): `http://<gateway-host>:<port>/v1/responses`

Internamente, las solicitudes se ejecutan como una ejecución normal de un agente del Gateway (mismo flujo de código que
`openclaw agent`), por lo que el enrutamiento/permisos/configuración coinciden con su Gateway.

## Autenticación

Usa la configuración de autenticación del Gateway. Envíe un token bearer:

- `Authorization: Bearer <token>`

Notas:

- Cuando `gateway.auth.mode="token"`, use `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Cuando `gateway.auth.mode="password"`, use `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).

## Elección de un agente

No se requieren encabezados personalizados: codifique el id del agente en el campo `model` de OpenResponses:

- `model: "openclaw:<agentId>"` (ejemplo: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

O apunte a un agente específico de OpenClaw por encabezado:

- `x-openclaw-agent-id: <agentId>` (predeterminado: `main`)

Avanzado:

- `x-openclaw-session-key: <sessionKey>` para controlar completamente el enrutamiento de sesiones.

## Habilitar el endpoint

Establezca `gateway.http.endpoints.responses.enabled` en `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: true },
      },
    },
  },
}
```

## Deshabilitar el endpoint

Establezca `gateway.http.endpoints.responses.enabled` en `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: { enabled: false },
      },
    },
  },
}
```

## Comportamiento de la sesión

Por defecto, el endpoint es **sin estado por solicitud** (se genera una nueva clave de sesión en cada llamada).

Si la solicitud incluye una cadena `user` de OpenResponses, el Gateway deriva una clave de sesión estable
a partir de ella, de modo que las llamadas repetidas pueden compartir una sesión de agente.

## Forma de la solicitud (compatible)

La solicitud sigue la API de OpenResponses con entrada basada en ítems. Compatibilidad actual:

- `input`: cadena o arreglo de objetos de ítems.
- `instructions`: se fusiona en el prompt del sistema.
- `tools`: definiciones de herramientas del cliente (herramientas de función).
- `tool_choice`: filtrar o requerir herramientas del cliente.
- `stream`: habilita streaming SSE.
- `max_output_tokens`: límite de salida de mejor esfuerzo (dependiente del proveedor).
- `user`: enrutamiento estable de sesión.

Aceptados pero **actualmente ignorados**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Ítems (entrada)

### `message`

Roles: `system`, `developer`, `user`, `assistant`.

- `system` y `developer` se agregan al prompt del sistema.
- El ítem `user` o `function_call_output` más reciente se convierte en el “mensaje actual”.
- Los mensajes anteriores de usuario/asistente se incluyen como historial para contexto.

### `function_call_output` (herramientas por turnos)

Envíe los resultados de herramientas de vuelta al modelo:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` y `item_reference`

Aceptados por compatibilidad de esquema, pero ignorados al construir el prompt.

## Herramientas (herramientas de función del lado del cliente)

Proporcione herramientas con `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

Si el agente decide llamar a una herramienta, la respuesta devuelve un ítem de salida `function_call`.
Luego, envíe una solicitud de seguimiento con `function_call_output` para continuar el turno.

## Imágenes (`input_image`)

Admite fuentes base64 o URL:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Tipos MIME permitidos (actuales): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Tamaño máximo (actual): 10MB.

## Archivos (`input_file`)

Admite fuentes base64 o URL:

```json
{
  "type": "input_file",
  "source": {
    "type": "base64",
    "media_type": "text/plain",
    "data": "SGVsbG8gV29ybGQh",
    "filename": "hello.txt"
  }
}
```

Tipos MIME permitidos (actuales): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Tamaño máximo (actual): 5MB.

Comportamiento actual:

- El contenido del archivo se decodifica y se agrega al **prompt del sistema**, no al mensaje del usuario,
  por lo que permanece efímero (no se persiste en el historial de la sesión).
- Los PDF se analizan para extraer texto. Si se encuentra poco texto, las primeras páginas se rasterizan
  en imágenes y se pasan al modelo.

El análisis de PDF utiliza la compilación heredada `pdfjs-dist` compatible con Node (sin worker). La compilación moderna
de PDF.js espera workers del navegador/globals del DOM, por lo que no se usa en el Gateway.

Valores predeterminados de obtención de URL:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- Las solicitudes están protegidas (resolución DNS, bloqueo de IP privadas, límites de redirección, timeouts).

## Límites de archivos + imágenes (configuración)

Los valores predeterminados pueden ajustarse en `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          files: {
            allowUrl: true,
            allowedMimes: [
              "text/plain",
              "text/markdown",
              "text/html",
              "text/csv",
              "application/json",
              "application/pdf",
            ],
            maxBytes: 5242880,
            maxChars: 200000,
            maxRedirects: 3,
            timeoutMs: 10000,
            pdf: {
              maxPages: 4,
              maxPixels: 4000000,
              minTextChars: 200,
            },
          },
          images: {
            allowUrl: true,
            allowedMimes: ["image/jpeg", "image/png", "image/gif", "image/webp"],
            maxBytes: 10485760,
            maxRedirects: 3,
            timeoutMs: 10000,
          },
        },
      },
    },
  },
}
```

Valores predeterminados cuando se omiten:

- `maxBodyBytes`: 20MB
- `files.maxBytes`: 5MB
- `files.maxChars`: 200k
- `files.maxRedirects`: 3
- `files.timeoutMs`: 10s
- `files.pdf.maxPages`: 4
- `files.pdf.maxPixels`: 4,000,000
- `files.pdf.minTextChars`: 200
- `images.maxBytes`: 10MB
- `images.maxRedirects`: 3
- `images.timeoutMs`: 10s

## Streaming (SSE)

Establezca `stream: true` para recibir Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Cada línea de evento es `event: <type>` y `data: <json>`
- El stream termina con `data: [DONE]`

Tipos de eventos emitidos actualmente:

- `response.created`
- `response.in_progress`
- `response.output_item.added`
- `response.content_part.added`
- `response.output_text.delta`
- `response.output_text.done`
- `response.content_part.done`
- `response.output_item.done`
- `response.completed`
- `response.failed` (en error)

## Uso

`usage` se completa cuando el proveedor subyacente informa recuentos de tokens.

## Errores

Los errores usan un objeto JSON como:

```json
{ "error": { "message": "...", "type": "invalid_request_error" } }
```

Casos comunes:

- `401` autenticación faltante/inválida
- `400` cuerpo de solicitud inválido
- `405` método incorrecto

## Ejemplos

Sin streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "input": "hi"
  }'
```

Con streaming:

```bash
curl -N http://127.0.0.1:18789/v1/responses \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "input": "hi"
  }'
```
