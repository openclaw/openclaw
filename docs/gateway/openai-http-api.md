---
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
---
# OpenAI-compatible HTTP API

Clawdbot’s Gateway can serve a small OpenAI-compatible endpoint:

- `POST /v1/chat/completions`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

Notes:
- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `CLAWDBOT_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `CLAWDBOT_GATEWAY_PASSWORD`).

## Choosing an agent

Target a specific Clawdbot agent by id:

- `x-clawdbot-agent-id: <agentId>` (default: `main`)

Advanced:
- `x-clawdbot-session-key: <sessionKey>` to fully control session routing.

## Session behavior

By default the endpoint is **stateless per request** (a new session key is generated each call).

If the request includes an OpenAI `user` string, the Gateway derives a stable session key from it, so repeated calls can share an agent session.

## Streaming (SSE)

Set `stream: true` to receive Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Each event line is `data: <json>`
- Stream ends with `data: [DONE]`

## Examples

Non-streaming:
```bash
curl -sS http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-clawdbot-agent-id: main' \
  -d '{
    "model": "clawdbot",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:
```bash
curl -N http://127.0.0.1:18789/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-clawdbot-agent-id: main' \
  -d '{
    "model": "clawdbot",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```

