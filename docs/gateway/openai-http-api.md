---
summary: "Expose an OpenAI-compatible /v1/chat/completions HTTP endpoint from the Gateway"
read_when:
  - Integrating tools that expect OpenAI Chat Completions
title: "OpenAI Chat Completions"
---

# OpenAI Chat Completions (HTTP)

Mullusi’s Gateway can serve a small OpenAI-compatible Chat Completions endpoint.

This endpoint is **disabled by default**. Enable it in config first.

- `POST /v1/chat/completions`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/v1/chat/completions`

When the Gateway’s OpenAI-compatible HTTP surface is enabled, it also serves:

- `GET /v1/models`
- `GET /v1/models/{id}`
- `POST /v1/embeddings`
- `POST /v1/responses`

Under the hood, requests are executed as a normal Gateway agent run (same codepath as `mullusi agent`), so routing/permissions/config match your Gateway.

## Authentication

Uses the Gateway auth configuration.

Common HTTP auth paths:

- shared-secret auth (`gateway.auth.mode="token"` or `"password"`):
  `Authorization: Bearer <token-or-password>`
- trusted identity-bearing HTTP auth (`gateway.auth.mode="trusted-proxy"`):
  route through the configured identity-aware proxy and let it inject the
  required identity headers
- private-ingress open auth (`gateway.auth.mode="none"`):
  no auth header required

Notes:

- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `MULLUSI_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `MULLUSI_GATEWAY_PASSWORD`).
- When `gateway.auth.mode="trusted-proxy"`, the HTTP request must come from a
  configured non-loopback trusted proxy source; same-host loopback proxies do
  not satisfy this mode.
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Security boundary (important)

Treat this endpoint as a **full operator-access** surface for the gateway instance.

- HTTP bearer auth here is not a narrow per-user scope model.
- A valid Gateway token/password for this endpoint should be treated like an owner/operator credential.
- Requests run through the same control-plane agent path as trusted operator actions.
- There is no separate non-owner/per-user tool boundary on this endpoint; once a caller passes Gateway auth here, Mullusi treats that caller as a trusted operator for this gateway.
- For shared-secret auth modes (`token` and `password`), the endpoint restores the normal full operator defaults even if the caller sends a narrower `x-mullusi-scopes` header.
- Trusted identity-bearing HTTP modes (for example trusted proxy auth or `gateway.auth.mode="none"`) honor `x-mullusi-scopes` when present and otherwise fall back to the normal operator default scope set.
- If the target agent policy allows sensitive tools, this endpoint can use them.
- Keep this endpoint on loopback/tailnet/private ingress only; do not expose it directly to the public internet.

Auth matrix:

- `gateway.auth.mode="token"` or `"password"` + `Authorization: Bearer ...`
  - proves possession of the shared gateway operator secret
  - ignores narrower `x-mullusi-scopes`
  - restores the full default operator scope set:
    `operator.admin`, `operator.approvals`, `operator.pairing`,
    `operator.read`, `operator.talk.secrets`, `operator.write`
  - treats chat turns on this endpoint as owner-sender turns
- trusted identity-bearing HTTP modes (for example trusted proxy auth, or `gateway.auth.mode="none"` on private ingress)
  - authenticate some outer trusted identity or deployment boundary
  - honor `x-mullusi-scopes` when the header is present
  - fall back to the normal operator default scope set when the header is absent
  - only lose owner semantics when the caller explicitly narrows scopes and omits `operator.admin`

See [Security](/gateway/security) and [Remote access](/gateway/remote).

## Agent-first model contract

Mullusi treats the OpenAI `model` field as an **agent target**, not a raw provider model id.

- `model: "mullusi"` routes to the configured default agent.
- `model: "mullusi/default"` also routes to the configured default agent.
- `model: "mullusi/<agentId>"` routes to a specific agent.

Optional request headers:

- `x-mullusi-model: <provider/model-or-bare-id>` overrides the backend model for the selected agent.
- `x-mullusi-agent-id: <agentId>` remains supported as a compatibility override.
- `x-mullusi-session-key: <sessionKey>` fully controls session routing.
- `x-mullusi-message-channel: <channel>` sets the synthetic ingress channel context for channel-aware prompts and policies.

Compatibility aliases still accepted:

- `model: "mullusi:<agentId>"`
- `model: "agent:<agentId>"`

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
    An Mullusi agent-target list.

    The returned ids are `mullusi`, `mullusi/default`, and `mullusi/<agentId>` entries.
    Use them directly as OpenAI `model` values.

  </Accordion>
  <Accordion title="Does `/v1/models` list agents or sub-agents?">
    It lists top-level agent targets, not backend provider models and not sub-agents.

    Sub-agents remain internal execution topology. They do not appear as pseudo-models.

  </Accordion>
  <Accordion title="Why is `mullusi/default` included?">
    `mullusi/default` is the stable alias for the configured default agent.

    That means clients can keep using one predictable id even if the real default agent id changes between environments.

  </Accordion>
  <Accordion title="How do I override the backend model?">
    Use `x-mullusi-model`.

    Examples:
    `x-mullusi-model: openai/gpt-5.4`
    `x-mullusi-model: gpt-5.4`

    If you omit it, the selected agent runs with its normal configured model choice.

  </Accordion>
  <Accordion title="How do embeddings fit this contract?">
    `/v1/embeddings` uses the same agent-target `model` ids.

    Use `model: "mullusi/default"` or `model: "mullusi/<agentId>"`.
    When you need a specific embedding model, send it in `x-mullusi-model`.
    Without that header, the request passes through to the selected agent's normal embedding setup.

  </Accordion>
</AccordionGroup>

## Streaming (SSE)

Set `stream: true` to receive Server-Sent Events (SSE):

- `Content-Type: text/event-stream`
- Each event line is `data: <json>`
- Stream ends with `data: [DONE]`

## Open WebUI quick setup

For a basic Open WebUI connection:

- Base URL: `http://127.0.0.1:18790/v1`
- Docker on macOS base URL: `http://host.docker.internal:18790/v1`
- API key: your Gateway bearer token
- Model: `mullusi/default`

Expected behavior:

- `GET /v1/models` should list `mullusi/default`
- Open WebUI should use `mullusi/default` as the chat model id
- If you want a specific backend provider/model for that agent, set the agent's normal default model or send `x-mullusi-model`

Quick smoke:

```bash
curl -sS http://127.0.0.1:18790/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

If that returns `mullusi/default`, most Open WebUI setups can connect with the same base URL and token.

## Examples

Non-streaming:

```bash
curl -sS http://127.0.0.1:18790/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "mullusi/default",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Streaming:

```bash
curl -N http://127.0.0.1:18790/v1/chat/completions \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-mullusi-model: openai/gpt-5.4' \
  -d '{
    "model": "mullusi/research",
    "stream": true,
    "messages": [{"role":"user","content":"hi"}]
  }'
```

List models:

```bash
curl -sS http://127.0.0.1:18790/v1/models \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Fetch one model:

```bash
curl -sS http://127.0.0.1:18790/v1/models/mullusi%2Fdefault \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

Create embeddings:

```bash
curl -sS http://127.0.0.1:18790/v1/embeddings \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -H 'x-mullusi-model: openai/text-embedding-3-small' \
  -d '{
    "model": "mullusi/default",
    "input": ["alpha", "beta"]
  }'
```

Notes:

- `/v1/models` returns Mullusi agent targets, not raw provider catalogs.
- `mullusi/default` is always present so one stable id works across environments.
- Backend provider/model overrides belong in `x-mullusi-model`, not the OpenAI `model` field.
- `/v1/embeddings` supports `input` as a string or array of strings.
