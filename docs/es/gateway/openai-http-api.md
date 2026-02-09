---
summary: "Exponer un endpoint HTTP /v1/chat/completions compatible con OpenAI desde el Gateway"
read_when:
  - Integrar herramientas que esperan Chat Completions de OpenAI
title: "Chat Completions de OpenAI"
---

# Chat Completions de OpenAI (HTTP)

El Gateway de OpenClaw puede servir un pequeño endpoint de Chat Completions compatible con OpenAI.

Este endpoint está **deshabilitado por defecto**. Habilítelo primero en la configuración.

- `POST /v1/chat/completions`
- Mismo puerto que el Gateway (multiplex WS + HTTP): `http://<gateway-host>:<port>/v1/chat/completions`

Internamente, las solicitudes se ejecutan como una ejecución normal de un agente del Gateway (el mismo flujo de código que `openclaw agent`), por lo que el enrutamiento, los permisos y la configuración coinciden con su Gateway.

## Autenticación

Usa la configuración de autenticación del Gateway. Envíe un token bearer:

- `Authorization: Bearer <token>`

Notas:

- Cuando `gateway.auth.mode="token"`, use `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Cuando `gateway.auth.mode="password"`, use `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).

## Elección de un agente

No se requieren encabezados personalizados: codifique el id del agente en el campo `model` de OpenAI:

- `model: "openclaw:<agentId>"` (ejemplo: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

O apunte a un agente específico de OpenClaw por encabezado:

- `x-openclaw-agent-id: <agentId>` (predeterminado: `main`)

Avanzado:

- `x-openclaw-session-key: <sessionKey>` para controlar completamente el enrutamiento de la sesión.

## Habilitar el endpoint

Establezca `gateway.http.endpoints.chatCompletions.enabled` en `true`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: true },
      },
    },
  },
}
```

## Deshabilitar el endpoint

Establezca `gateway.http.endpoints.chatCompletions.enabled` en `false`:

```json5
{
  gateway: {
    http: {
      endpoints: {
        chatCompletions: { enabled: false },
      },
    },
  },
}
```

## Comportamiento de la sesión

Por defecto, el endpoint es **sin estado por solicitud** (se genera una nueva clave de sesión en cada llamada).

Si la solicitud incluye una cadena `user` de OpenAI, el Gateway deriva una clave de sesión estable a partir de ella, de modo que las llamadas repetidas pueden compartir una sesión del agente.

## Streaming (SSE)

Establezca `stream: true` para recibir Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Cada línea de evento es `data: <json>`
- El stream termina con `data: [DONE]`

## Ejemplos

Sin streaming:

```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Con streaming:

```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openclaw",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```
