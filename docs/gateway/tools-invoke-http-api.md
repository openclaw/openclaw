---
summary: "Invoke a single tool directly via the Gateway HTTP endpoint"
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: "Tools Invoke API"
---

# Tools Invoke (HTTP)

OpenClaw’s Gateway exposes a simple HTTP endpoint for invoking a single tool directly. It is always enabled and uses Gateway auth plus tool policy, but callers that pass Gateway bearer auth are treated as trusted operators for that gateway.

- `POST /tools/invoke`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`

Default max payload size is 2 MB.

## Authentication

Uses the Gateway auth configuration. Send a bearer token:

- `Authorization: Bearer <token>`

Notes:

- When `gateway.auth.mode="token"`, use `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
- When `gateway.auth.mode="password"`, use `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.
- Treat this credential as a full-access operator secret for that gateway. It is not a scoped API token for a narrower `/tools/invoke` role.

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

- `POST /tools/invoke` is in the same trusted-operator bucket as other Gateway HTTP APIs such as `/v1/chat/completions`, `/v1/responses`, and `/api/channels/*`.
- Exec approvals are operator guardrails, not a separate authorization boundary for this HTTP endpoint. If a tool is reachable here via Gateway auth + tool policy, `/tools/invoke` does not add an extra per-call approval prompt.
- Do not share Gateway bearer credentials with untrusted callers. If you need separation across trust boundaries, run separate gateways (and ideally separate OS users/hosts).

Gateway HTTP also applies a hard deny list by default (even if session policy allows the tool):

- `exec` — direct command execution (RCE surface)
- `spawn` — arbitrary child process creation (RCE surface)
- `shell` — shell command execution (RCE surface)
- `fs_write` — arbitrary file mutation on the host
- `fs_delete` — arbitrary file deletion on the host
- `fs_move` — arbitrary file move/rename on the host
- `apply_patch` — patch application can rewrite arbitrary files
- `sessions_spawn` — session orchestration; spawning agents remotely is RCE
- `sessions_send` — cross-session message injection
- `cron` — persistent automation control plane
- `gateway` — gateway control plane; prevents reconfiguration via HTTP
- `nodes` — node command relay can reach system.run on paired hosts
- `whatsapp_login` — interactive setup requiring terminal QR scan; hangs on HTTP

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
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "sessions_list",
    "action": "json",
    "args": {}
  }'
```
