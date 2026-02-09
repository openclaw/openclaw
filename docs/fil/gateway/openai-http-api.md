---
summary: "Ilantad ang OpenAI-compatible na /v1/chat/completions HTTP endpoint mula sa Gateway"
read_when:
  - Pagsasama ng mga tool na umaasa sa OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Kayang maghatid ng OpenClaw Gateway ng isang maliit na OpenAI-compatible na Chat Completions endpoint.

This endpoint is **disabled by default**. I-enable muna ito sa config.

- `POST /v1/chat/completions`
- Parehong port ng Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

Sa ilalim ng hood, ang mga request ay isinasagawa bilang isang normal na Gateway agent run (parehong codepath gaya ng `openclaw agent`), kaya tumutugma ang routing/permissions/config sa iyong Gateway.

## Authentication

Uses the Gateway auth configuration. Magpadala ng bearer token:

- `Authorization: Bearer <token>`

Mga tala:

- Kapag `gateway.auth.mode="token"`, gamitin ang `gateway.auth.token` (o `OPENCLAW_GATEWAY_TOKEN`).
- Kapag `gateway.auth.mode="password"`, gamitin ang `gateway.auth.password` (o `OPENCLAW_GATEWAY_PASSWORD`).

## Pagpili ng agent

Walang kailangang custom headers: i-encode ang agent id sa OpenAI `model` field:

- `model: "openclaw:<agentId>"` (halimbawa: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

O tumukoy ng partikular na OpenClaw agent sa pamamagitan ng header:

- `x-openclaw-agent-id: <agentId>` (default: `main`)

Advanced:

- `x-openclaw-session-key: <sessionKey>` para ganap na makontrol ang session routing.

## Pag-enable ng endpoint

Itakda ang `gateway.http.endpoints.chatCompletions.enabled` sa `true`:

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

## Pag-disable ng endpoint

Itakda ang `gateway.http.endpoints.chatCompletions.enabled` sa `false`:

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

## Pag-uugali ng session

Bilang default, ang endpoint ay **stateless kada request** (may bagong session key na nalilikha sa bawat tawag).

Kung may kasamang OpenAI `user` string ang request, nagde-derive ang Gateway ng isang stable na session key mula rito, kaya puwedeng magbahagi ng agent session ang mga paulit-ulit na tawag.

## Streaming (SSE)

Itakda ang `stream: true` para tumanggap ng Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Ang bawat event line ay `data: <json>`
- Nagtatapos ang stream sa `data: [DONE]`

## Mga halimbawa

Non-streaming:

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

Streaming:

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
