---
summary: "Expón un endpoint HTTP compatible con OpenResponses /v1/responses desde el Gateway"
read_when:
  - Integrando clientes que hablan la API de OpenResponses
  - Quieres entradas basadas en items, llamadas de herramientas del cliente o eventos SSE
title: "API de OpenResponses"
---

# API de OpenResponses (HTTP)

El Gateway de OpenClaw puede servir un endpoint compatible con OpenResponses `POST /v1/responses`.

Este endpoint está **deshabilitado por defecto**. Habilítalo primero en la configuración.

- `POST /v1/responses`
- Mismo puerto que el Gateway (multiplex WS + HTTP): `http://<gateway-host>:<port>/v1/responses`

Internamente, las solicitudes se ejecutan como una ejecución de agente normal del Gateway (mismo código que
`openclaw agent`), por lo que el enrutamiento/permisos/config coinciden con tu Gateway.

## Autenticación

Usa la configuración de autenticación del Gateway. Envía un bearer token:

- `Authorization: Bearer <token>`

Notas:

- Cuando `gateway.auth.mode="token"`, usa `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Cuando `gateway.auth.mode="password"`, usa `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).
- Si `gateway.auth.rateLimit` está configurado y ocurren demasiadas fallas de autenticación, el endpoint devuelve `429` con `Retry-After`.

## Elegir un agente

No se requieren encabezados personalizados: codifica el id del agente en el campo `model` de OpenResponses:

- `model: "openclaw:<agentId>"` (ejemplo: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

O dirige a un agente específico de OpenClaw por encabezado:

- `x-openclaw-agent-id: <agentId>` (predeterminado: `main`)

Avanzado:

- `x-openclaw-session-key: <sessionKey>` para controlar completamente el enrutamiento de la sesión.

## Habilitando el endpoint

Establece `gateway.http.endpoints.responses.enabled` en `true`:

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

## Deshabilitando el endpoint

Establece `gateway.http.endpoints.responses.enabled` en `false`:

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

Si la solicitud incluye un string `user` de OpenResponses, el Gateway deriva una clave de sesión estable
a partir de él, por lo que las llamadas repetidas pueden compartir una sesión de agente.

## Forma de la solicitud (soportado)

La solicitud sigue la API de OpenResponses con entrada basada en items. Soporte actual:

- `input`: string o array de objetos item.
- `instructions`: se fusiona en el prompt del sistema.
- `tools`: definiciones de herramientas del cliente (herramientas de función).
- `tool_choice`: filtra o requiere herramientas del cliente.
- `stream`: habilita streaming SSE.
- `max_output_tokens`: límite de salida de mejor esfuerzo (dependiente del proveedor).
- `user`: enrutamiento de sesión estable.

Aceptado pero **actualmente ignorado**:

- `max_tool_calls`
- `reasoning`
- `metadata`
- `store`
- `previous_response_id`
- `truncation`

## Items (input)

### `message`

Roles: `system`, `developer`, `user`, `assistant`.

- `system` y `developer` se añaden al prompt del sistema.
- El item `user` o `function_call_output` más reciente se convierte en el "mensaje actual".
- Los mensajes anteriores de user/assistant se incluyen como historial para contexto.

### `function_call_output` (herramientas basadas en turnos)

Envía resultados de herramientas de vuelta al modelo:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\": \"72F\"}"
}
```

### `reasoning` e `item_reference`

Aceptados para compatibilidad de esquema pero ignorados al construir el prompt.

## Herramientas (herramientas de función del lado del cliente)

Proporciona herramientas con `tools: [{ type: "function", function: { name, description?, parameters? } }]`.

Si el agente decide llamar a una herramienta, la respuesta devuelve un item de salida `function_call`.
Luego envías una solicitud de seguimiento con `function_call_output` para continuar el turno.

## Imágenes (`input_image`)

Soporta fuentes base64 o URL:

```json
{
  "type": "input_image",
  "source": { "type": "url", "url": "https://example.com/image.png" }
}
```

Tipos MIME permitidos (actual): `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
Tamaño máximo (actual): 10MB.

## Archivos (`input_file`)

Soporta fuentes base64 o URL:

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

Tipos MIME permitidos (actual): `text/plain`, `text/markdown`, `text/html`, `text/csv`,
`application/json`, `application/pdf`.

Tamaño máximo (actual): 5MB.

Comportamiento actual:

- El contenido del archivo se decodifica y se añade al **prompt del sistema**, no al mensaje del usuario,
  por lo que permanece efímero (no persistido en el historial de la sesión).
- Los PDFs se analizan para texto. Si se encuentra poco texto, las primeras páginas se rasterizan
  en imágenes y se pasan al modelo.

El análisis de PDF usa la compilación legacy `pdfjs-dist` compatible con Node (sin worker). La
compilación moderna de PDF.js espera workers/globals DOM del navegador, por lo que no se usa en el Gateway.

Valores predeterminados de obtención de URL:

- `files.allowUrl`: `true`
- `images.allowUrl`: `true`
- `maxUrlParts`: `8` (total de partes `input_file` + `input_image` basadas en URL por solicitud)
- Las solicitudes están protegidas (resolución DNS, bloqueo de IP privada, límites de redirección, timeouts).
- Se admiten listas de permitidos de hostname opcionales por tipo de entrada (`files.urlAllowlist`, `images.urlAllowlist`).
  - Host exacto: `"cdn.example.com"`
  - Subdominios comodín: `"*.assets.example.com"` (no coincide con el apex)

## Límites de archivos + imágenes (config)

Los valores predeterminados se pueden ajustar bajo `gateway.http.endpoints.responses`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        responses: {
          enabled: true,
          maxBodyBytes: 20000000,
          maxUrlParts: 8,
          files: {
            allowUrl: true,
            urlAllowlist: ["cdn.example.com", "*.assets.example.com"],
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
            urlAllowlist: ["images.example.com"],
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
- `maxUrlParts`: 8
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

Nota de seguridad:

- Las listas de permitidos de URL se aplican antes de la obtención y en los saltos de redirección.
- Permitir un hostname no evita el bloqueo de IP privadas/internas.
- Para gateways expuestos a internet, aplica controles de salida de red además de las protecciones a nivel de aplicación.
  Ver [Seguridad](/es-ES/gateway/security).

## Streaming (SSE)

Establece `stream: true` para recibir Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Cada línea de evento es `event: <type>` y `data: <json>`
- El stream termina con `data: [DONE]`

Tipos de eventos actualmente emitidos:

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

`usage` se rellena cuando el proveedor subyacente informa recuentos de tokens.

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
