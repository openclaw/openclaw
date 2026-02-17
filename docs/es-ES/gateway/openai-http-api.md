---
summary: "Expón un endpoint HTTP compatible con OpenAI /v1/chat/completions desde el Gateway"
read_when:
  - Integrando herramientas que esperan Chat Completions de OpenAI
title: "Chat Completions de OpenAI"
---

# Chat Completions de OpenAI (HTTP)

El Gateway de OpenClaw puede servir un pequeño endpoint compatible con OpenAI Chat Completions.

Este endpoint está **deshabilitado por defecto**. Habilítalo primero en la configuración.

- `POST /v1/chat/completions`
- Mismo puerto que el Gateway (multiplex WS + HTTP): `http://<gateway-host>:<port>/v1/chat/completions`

Internamente, las solicitudes se ejecutan como una ejecución de agente normal del Gateway (mismo código que `openclaw agent`), por lo que el enrutamiento/permisos/config coinciden con tu Gateway.

## Autenticación

Usa la configuración de autenticación del Gateway. Envía un bearer token:

- `Authorization: Bearer <token>`

Notas:

- Cuando `gateway.auth.mode="token"`, usa `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Cuando `gateway.auth.mode="password"`, usa `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).
- Si `gateway.auth.rateLimit` está configurado y ocurren demasiadas fallas de autenticación, el endpoint devuelve `429` con `Retry-After`.

## Elegir un agente

No se requieren encabezados personalizados: codifica el id del agente en el campo `model` de OpenAI:

- `model: "openclaw:<agentId>"` (ejemplo: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

O dirige a un agente específico de OpenClaw por encabezado:

- `x-openclaw-agent-id: <agentId>` (predeterminado: `main`)

Avanzado:

- `x-openclaw-session-key: <sessionKey>` para controlar completamente el enrutamiento de la sesión.

## Habilitando el endpoint

Establece `gateway.http.endpoints.chatCompletions.enabled` en `true`:

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

## Deshabilitando el endpoint

Establece `gateway.http.endpoints.chatCompletions.enabled` en `false`:

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

Si la solicitud incluye un string `user` de OpenAI, el Gateway deriva una clave de sesión estable a partir de él, por lo que las llamadas repetidas pueden compartir una sesión de agente.

## Streaming (SSE)

Establece `stream: true` para recibir Server-Sent Events (SSE):

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
