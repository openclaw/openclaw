---
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

OpenClaw’s Gateway can serve a small OpenAI-compatible Chat Completions endpoint.

This endpoint is **disabled by default**. Enable it in config first.

- `POST /v1/chat/completions`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

When the Gateway’s OpenAI-compatible HTTP surface is enabled, it also serves:

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/responses`

Under the hood, requests are executed as a normal Gateway agent run (same codepath as `openclaw agent`), so routing/permissions/config match your Gateway.

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

Notes:

- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Security boundary (important)

Treat this endpoint as a **full operator-access** surface for the gateway instance.

- HTTP bearer auth here is not a narrow per-user scope model.
- A valid Gateway token/password for this endpoint should be treated like an owner/operator credential.
- Requests run through the same control-plane agent path as trusted operator actions.
- There is no separate non-owner/per-user tool boundary on this endpoint; once a caller passes Gateway auth here, OpenClaw treats that caller as a trusted operator for this gateway.
- If the target agent policy allows sensitive tools, this endpoint can use them.
- Keep this endpoint on loopback/tailnet/private ingress only; do not expose it directly to the public internet.

See [Security](/gateway/security) and [Remote access](/gateway/remote).

## Choosing an agent

No custom headers required: encode the agent id in the OpenAI `model` field:

- `model: "openclaw:<agentId>"` (example: `"openclaw:main"`, `"openclaw:beta"`)
- `model: "agent:<agentId>"` (alias)

Or target a specific OpenClaw agent by header:

- `x-openclaw-agent-id: <agentId>` (default: `main`)

Advanced:

- `x-openclaw-session-key: <sessionKey>` to fully control session routing.
- `x-openclaw-message-channel: <channel>` to set the synthetic ingress channel context for channel-aware prompts and policies.

For `/v1/models` and `/v1/embeddings`, `x-openclaw-agent-id` is still useful:

- `/v1/models` uses it for agent-scoped model filtering where relevant.
- `/v1/embeddings` uses it to resolve agent-specific memory-search embedding config.

## Enabling the endpoint

Set `gateway.http.endpoints.chatCompletions.enabled` to `true`:

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

## Disabling the endpoint

Set `gateway.http.endpoints.chatCompletions.enabled` to `false`:

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

## Session behavior

By default the endpoint is **stateless per request** (a new session key is generated each call).

If the request includes an OpenAI `user` string, the Gateway derives a stable session key from it, so repeated calls can share an agent session.

## Why this surface matters

This is the highest-leverage compatibility set for self-hosted frontends and tooling:

- Most Open WebUI, LobeChat, and LibreChat setups expect `/v1/models`.
- Many RAG systems expect `/v1/embeddings`.
- Existing OpenAI chat clients can usually start with `/v1/chat/completions`.
- More agent-native clients increasingly prefer `/v1/responses`.

## Model list and agent routing

<AccordionGroup>
  <Accordion title="What does `/v1/models` return?">
    A flat OpenAI-style model list.

    The returned ids are canonical `provider/model` values such as `openai/gpt-5.4`.
    These ids are meant to be passed back directly as the OpenAI `model` field.

  </Accordion>
  <Accordion title="Does `/v1/models` list agents or sub-agents?">
    No.

    `/v1/models` lists model choices, not execution topology. Agents and sub-agents are OpenClaw routing concerns, so they are selected separately with `x-openclaw-agent-id` or the `openclaw:<agentId>` / `agent:<agentId>` model aliases on chat and responses requests.

  </Accordion>
  <Accordion title="How does agent-scoped filtering work?">
    Send `x-openclaw-agent-id: <agentId>` when you want the model list for a specific agent.

    OpenClaw filters the model list against that agent's allowed models and fallbacks when configured. If no allowlist is configured, the endpoint returns the full catalog.

  </Accordion>
  <Accordion title="How do sub-agents pick a model?">
    Sub-agent model choice is resolved at spawn time from OpenClaw agent config.

    That means sub-agent model selection does not create extra `/v1/models` entries. Keep the compatibility list flat, and treat agent and sub-agent selection as separate OpenClaw-native routing behavior.

  </Accordion>
  <Accordion title="What should clients do in practice?">
    Use `/v1/models` to populate the normal model picker.

    If your client or integration also knows which OpenClaw agent it wants, set `x-openclaw-agent-id` when listing models and when sending chat, responses, or embeddings requests. That keeps the picker aligned with the target agent's allowed model set.

  </Accordion>
</AccordionGroup>

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

List models:

```bash
curl -sS http://127.0.0.1:18789/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Fetch one model:

```bash
curl -sS http://127.0.0.1:18789/v1/models/openai%2Fgpt-5.4 \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Create embeddings:

```bash
curl -sS http://127.0.0.1:18789/v1/embeddings \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-openclaw-agent-id: main' \
  -d '{
    "model": "openai/text-embedding-3-small",
    "input": ["alpha", "beta"]
  }'
```

Notes:

- `/v1/models` returns canonical ids in `provider/model` form so they can be passed back directly as OpenAI `model` values.
- `/v1/models` stays flat on purpose: it does not enumerate agents or sub-agents as pseudo-model ids.
- `/v1/embeddings` supports `input` as a string or array of strings.
