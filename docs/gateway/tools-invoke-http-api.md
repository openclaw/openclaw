---
summary: "Invoke a single tool directly via the Gateway HTTP endpoint"
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: "Tools invoke API"
---

# Tools Invoke (HTTP)

OpenClaw’s Gateway exposes a simple HTTP endpoint for invoking a single tool directly. It is always enabled and uses Gateway auth plus tool policy. Like the OpenAI-compatible `/v1/*` surface, shared-secret bearer auth is treated as trusted operator access for the whole gateway.

- `POST /tools/invoke`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`

Default max payload size is 2 MB.

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

- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- When `gateway.auth.mode="trusted-proxy"`, the HTTP request must come from a
  configured trusted proxy source; same-host loopback proxies require explicit
  `gateway.auth.trustedProxy.allowLoopback = true`.
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Security boundary (important)

Treat this endpoint as a **full operator-access** surface for the gateway instance.

- HTTP bearer auth here is not a narrow per-user scope model.
- A valid Gateway token/password for this endpoint should be treated like an owner/operator credential.
- For shared-secret auth modes (`token` and `password`), the endpoint restores the normal full operator defaults even if the caller sends a narrower `x-openclaw-scopes` header.
- Shared-secret auth also treats direct tool invokes on this endpoint as owner-sender turns.
- Trusted identity-bearing HTTP modes (for example trusted proxy auth or `gateway.auth.mode="none"` on a private ingress) honor `x-openclaw-scopes` when present and otherwise fall back to the normal operator default scope set.
- Keep this endpoint on loopback/tailnet/private ingress only; do not expose it directly to the public internet.

Auth matrix:

- `gateway.auth.mode="token"` or `"password"` + `Authorization: Bearer ...`
  - proves possession of the shared gateway operator secret
  - ignores narrower `x-openclaw-scopes`
  - restores the full default operator scope set:
    `operator.admin`, `operator.approvals`, `operator.pairing`,
    `operator.read`, `operator.talk.secrets`, `operator.write`
  - treats direct tool invokes on this endpoint as owner-sender turns
- trusted identity-bearing HTTP modes (for example trusted proxy auth, or `gateway.auth.mode="none"` on private ingress)
  - authenticate some outer trusted identity or deployment boundary
  - honor `x-openclaw-scopes` when the header is present
  - fall back to the normal operator default scope set when the header is absent
  - only lose owner semantics when the caller explicitly narrows scopes and omits `operator.admin`

## Request body

```json
{
  "tool": "sessions_list",
  "action": "json",
  "args": {},
  "sessionKey": "main",
  "dryRun": false
}
```

Fields:

- `tool` (string, required): tool name to invoke.
- `action` (string, optional): mapped into args if the tool schema supports `action` and the args payload omitted it.
- `args` (object, optional): tool-specific arguments.
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and default agent, or `global` in global scope).
- `dryRun` (boolean, optional): reserved for future use; currently ignored.

## Policy + routing behavior

Tool availability is filtered through the same policy chain used by Gateway agents:

- `tools.profile` / `tools.byProvider.profile`
- `tools.allow` / `tools.byProvider.allow`
- `agents.<id>.tools.allow` / `agents.<id>.tools.byProvider.allow`
- group policies (if the session key maps to a group or channel)
- subagent policy (when invoking with a subagent session key)

If a tool is not allowed by policy, the endpoint returns **404**.

Important boundary notes:

- Exec approvals are operator guardrails, not a separate authorization boundary for this HTTP endpoint. If a tool is reachable here via Gateway auth + tool policy, `/tools/invoke` does not add an extra per-call approval prompt.
- Do not share Gateway bearer credentials with untrusted callers. If you need separation across trust boundaries, run separate gateways (and ideally separate OS users/hosts).

Gateway HTTP also applies a hard deny list by default (even if session policy allows the tool):

- `exec` — direct command execution (RCE surface)
- `spawn` — arbitrary child process creation (RCE surface)
- `shell` — shell command execution (RCE surface)
- `process` — background process orchestration; sibling of exec (RCE surface via shell)
- `write` — canonical workspace write tool; arbitrary file mutation on the host
- `edit` — canonical workspace edit tool; arbitrary file mutation on the host
- `fs_write` — arbitrary file mutation on the host (legacy/alternate name)
- `fs_delete` — arbitrary file deletion on the host
- `fs_move` — arbitrary file move/rename on the host
- `apply_patch` — patch application can rewrite arbitrary files (note: not currently materializable via `/tools/invoke` even if allowlisted, since this surface has no session-bound model context and `apply_patch` is provider-gated to OpenAI-family models)
- `sessions_spawn` — session orchestration; spawning agents remotely is RCE
- `sessions_send` — cross-session message injection
- `cron` — persistent automation control plane
- `gateway` — gateway control plane; prevents reconfiguration via HTTP
- `nodes` — node command relay can reach system.run on paired hosts
- `whatsapp_login` — interactive setup requiring terminal QR scan; hangs on HTTP

### Coding tools available via HTTP

The default coding-primitive tools (`read`, plus the deny-listed `write`/`edit`/`exec`/`process` if allowlisted) are reachable here for deterministic automation use cases that don't need a full LLM round-trip (linting, tests, browser capture, etc.). They are constructed via the unwrapped factory `createOpenClawCodingToolsRaw()`, which omits plugin-capable tools and provider-gated tools — the resolver's plugin-suppression intent is honored end-to-end.

You can customize this deny list via `gateway.tools`:

```json5
{
  gateway: {
    tools: {
      // Additional tools to block over HTTP /tools/invoke
      deny: ["browser"],
      // Remove tools from the default deny list
      allow: ["gateway"],
    },
  },
}
```

To help group policies resolve context, you can optionally set:

- `x-openclaw-message-channel: <channel>` (example: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (when multiple accounts exist)

## Responses

- `200` → `{ ok: true, result }`
- `400` → `{ ok: false, error: { type, message } }` (invalid request or tool input error)
- `401` → unauthorized
- `429` → auth rate-limited (`Retry-After` set)
- `404` → tool not available (not found or not allowlisted)
- `405` → method not allowed
- `500` → `{ ok: false, error: { type, message } }` (unexpected tool execution error; sanitized message)

## Example

```bash
curl -sS http://127.0.0.1:18789/tools/invoke \
  -H 'Authorization: Bearer secret' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```

## Related

- [Gateway protocol](/gateway/protocol)
- [Tools and plugins](/tools)
