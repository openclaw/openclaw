---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Integrating tools that expect OpenAI Chat Completions（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "OpenAI Chat Completions"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenAI Chat Completions (HTTP)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
OpenClaw’s Gateway can serve a small OpenAI-compatible Chat Completions endpoint.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This endpoint is **disabled by default**. Enable it in config first.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `POST /v1/chat/completions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Under the hood, requests are executed as a normal Gateway agent run (same codepath as `openclaw agent`), so routing/permissions/config match your Gateway.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Authentication（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Uses the Gateway auth configuration. Send a bearer token:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Authorization: Bearer <token>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Choosing an agent（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
No custom headers required: encode the agent id in the OpenAI `model` field:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model: "openclaw:<agentId>"` (example: `"openclaw:main"`, `"openclaw:beta"`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `model: "agent:<agentId>"` (alias)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Or target a specific OpenClaw agent by header:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-agent-id: <agentId>` (default: `main`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Advanced:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `x-openclaw-session-key: <sessionKey>` to fully control session routing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Enabling the endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `gateway.http.endpoints.chatCompletions.enabled` to `true`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    http: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      endpoints: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        chatCompletions: { enabled: true },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Disabling the endpoint（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `gateway.http.endpoints.chatCompletions.enabled` to `false`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  gateway: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    http: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      endpoints: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        chatCompletions: { enabled: false },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Session behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
By default the endpoint is **stateless per request** (a new session key is generated each call).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If the request includes an OpenAI `user` string, the Gateway derives a stable session key from it, so repeated calls can share an agent session.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Streaming (SSE)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set `stream: true` to receive Server-Sent Events (SSE):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `Content-Type: text/event-stream`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Each event line is `data: <json>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stream ends with `data: [DONE]`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Examples（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Non-streaming:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -sS http://127.0.0.1:18789/v1/chat/completions \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Authorization: Bearer YOUR_TOKEN' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'x-openclaw-agent-id: main' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "model": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "messages": [{"role":"user","content":"hi"}]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Streaming:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
curl -N http://127.0.0.1:18789/v1/chat/completions \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Authorization: Bearer YOUR_TOKEN' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'Content-Type: application/json' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -H 'x-openclaw-agent-id: main' \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  -d '{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "model": "openclaw",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "stream": true,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "messages": [{"role":"user","content":"hi"}]（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }'（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
