---
summary: "Invoke a single tool directly via the Gateway HTTP endpoint"
read_when:
  - Calling tools without running a full agent turn
  - Building automations that need tool policy enforcement
title: "Tools invoke API"
---

OpenClaw's Gateway exposes an HTTP endpoint for invoking a single tool directly. It is always enabled and uses Gateway auth plus tool policy. Like the OpenAI-compatible `/v1/*` surface, shared-secret bearer auth is treated as trusted operator access for the whole gateway.

- `POST /tools/invoke`
- Same port as the Gateway (WS + HTTP multiplex): `http://<gateway-host>:<port>/tools/invoke`
- Default max request body size: 2 MB

## Authentication

Uses the Gateway auth configuration.

Common HTTP auth paths:

- shared-secret auth (`gateway.auth.mode="token"` or `"password"`): `Authorization: Bearer <token-or-password>`
- trusted identity-bearing HTTP auth (`gateway.auth.mode="trusted-proxy"`): route through the configured identity-aware proxy and let it inject the required identity headers
- private-ingress open auth (`gateway.auth.mode="none"`): no auth header required

Notes:

- `mode="token"` uses `gateway.auth.token` (or `OPENCLAW_GATEWAY_TOKEN`).
- `mode="password"` uses `gateway.auth.password` (or `OPENCLAW_GATEWAY_PASSWORD`).
- `mode="trusted-proxy"` requires the HTTP request to come from a configured trusted proxy source; same-host loopback proxies require explicit `gateway.auth.trustedProxy.allowLoopback = true`.
- Internal same-host callers that bypass the proxy can use `gateway.auth.password` / `OPENCLAW_GATEWAY_PASSWORD` as a local direct fallback. Any `Forwarded`, `X-Forwarded-*`, or `X-Real-IP` header evidence keeps the request on the trusted-proxy path instead.
- If `gateway.auth.rateLimit` is configured and too many auth failures occur, the endpoint returns `429` with `Retry-After`.

## Security boundary (important)

Treat this endpoint as a **full operator-access** surface for the gateway instance.

- HTTP bearer auth here is not a narrow per-user scope model.
- A valid Gateway token/password for this endpoint should be treated like an owner/operator credential.
- For shared-secret auth modes (`token` and `password`), the endpoint restores the normal full operator defaults even if the caller sends a narrower `x-openclaw-scopes` header.
- Shared-secret auth also treats direct tool invokes on this endpoint as owner-sender turns.
- Trusted identity-bearing HTTP modes (trusted proxy auth, or `gateway.auth.mode="none"` on a private ingress) honor `x-openclaw-scopes` when present and otherwise fall back to the normal operator default scope set.
- Keep this endpoint on loopback/tailnet/private ingress only; do not expose it directly to the public internet.

Auth matrix:

| Auth mode                                                                               | Behavior                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token` or `password` + `Authorization: Bearer ...`                                     | Proves possession of the shared gateway operator secret. Ignores narrower `x-openclaw-scopes`. Restores the full default operator scope set: `operator.admin`, `operator.approvals`, `operator.pairing`, `operator.read`, `operator.talk.secrets`, `operator.write`. Treats direct tool invokes as owner-sender turns. |
| Trusted identity-bearing HTTP (trusted proxy auth, or `mode="none"` on private ingress) | Authenticates an outer trusted identity or deployment boundary. Honors `x-openclaw-scopes` when present. Falls back to the normal operator default scope set when the header is absent. Only loses owner semantics when the caller explicitly narrows scopes and omits `operator.admin`.                               |

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

- `tool` / `name` (string, required): tool name to invoke. `name` takes precedence if both are sent.
- `action` (string, optional): merged into `args.action` if the tool schema supports an `action` property and `args` did not already set one.
- `args` (object, optional): tool-specific arguments.
- `sessionKey` (string, optional): target session key. If omitted or `"main"`, the Gateway uses the configured main session key (honors `session.mainKey` and the default agent, or `global` in global session scope).
- `agentId` (string, optional): resolves the session key for that agent. Errors with `400` if it conflicts with an explicit `sessionKey` that already maps to a different agent.
- `idempotencyKey` (string, optional): used to derive a stable tool-call id for the invocation.
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
- If `exec` is reachable here, treat it as a mutating shell surface. Denying `write`, `edit`, `apply_patch`, or HTTP filesystem-write tools does not make shell execution read-only.
- Do not share Gateway bearer credentials with untrusted callers. If you need separation across trust boundaries, run separate gateways (ideally on separate OS users/hosts).

Gateway HTTP also applies a hard deny list by default (even if session policy allows the tool):

| Tool             | Reason                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec`           | Direct command execution (RCE surface)                                                                                                                                                                         |
| `spawn`          | Arbitrary child process creation (RCE surface)                                                                                                                                                                 |
| `shell`          | Shell command execution (RCE surface)                                                                                                                                                                          |
| `read`           | Host filesystem read; opt-in via dual-key `gateway.tools.directInvoke.hostFsRead: true` AND `gateway.tools.allow: ["read"]` (see "Opt-in: coding tool `read` over direct-invoke" below)                        |
| `write`          | Canonical workspace write tool; opt-in via dual-key `gateway.tools.directInvoke.hostFsWrite: true` AND `gateway.tools.allow: ["write"]` (see "Opt-in: coding tools `write` / `edit` over direct-invoke" below) |
| `edit`           | Canonical workspace edit tool; same dual-key opt-in as `write`                                                                                                                                                 |
| `fs_write`       | Arbitrary file mutation on the host                                                                                                                                                                            |
| `fs_delete`      | Arbitrary file deletion on the host                                                                                                                                                                            |
| `fs_move`        | Arbitrary file move/rename on the host                                                                                                                                                                         |
| `apply_patch`    | Patch application can rewrite arbitrary files                                                                                                                                                                  |
| `sessions_spawn` | Session orchestration; spawning agents remotely is RCE                                                                                                                                                         |
| `sessions_send`  | Cross-session message injection                                                                                                                                                                                |
| `cron`           | Persistent automation control plane                                                                                                                                                                            |
| `gateway`        | Gateway control plane; prevents reconfiguration via HTTP                                                                                                                                                       |
| `nodes`          | Node command relay can reach `system.run` on paired hosts                                                                                                                                                      |

`cron`, `gateway`, and `nodes` are also owner-only: even outside this default deny list, non-owner callers cannot invoke them on this surface.

Customize the general deny list via `gateway.tools`:

```json5
{
  gateway: {
    tools: {
      // Additional tools to block over HTTP /tools/invoke
      deny: ["browser"],
      // Remove tools from the default deny list for owner/admin callers
      allow: ["gateway"],
    },
  },
}
```

`gateway.tools.allow` is an exposure override, not a scope upgrade. In identity-bearing HTTP modes, `cron`, `gateway`, and `nodes` remain unavailable to callers without owner/admin identity (`operator.admin`) even when listed in `gateway.tools.allow`. Shared-secret bearer auth still follows the full trusted-operator rule above.

### Opt-in: coding tool `read` over direct-invoke

The `read` coding tool can be exposed for deterministic automation (CI/preflight
checks, lint pipelines, browser capture flows) without an LLM round-trip. This
applies to BOTH `POST /tools/invoke` AND the SDK-facing JSON-RPC `tools.invoke`
(they share the same direct-invoke resolver).

**`read` is denied by default.** Reaching it requires TWO distinct config keys
(set intentionally) AND an owner/admin sender at request time. The two config
keys:

```json5
{
  gateway: {
    tools: {
      // (1) Lift `read` from the HTTP default deny list (same opt-in shape as
      // the other dangerous-by-default tools).
      allow: ["read"],
      // (2) NEW: distinct direct-invoke opt-in. Without this, the `read` tool
      // is not materialized into the candidate set even if `allow` includes it.
      // This dual-key gating prevents an upgrade-time compatibility break for
      // pre-existing configs that already include `"read"` in `allow` for
      // unrelated reasons (e.g. for an MCP/agent surface where `read` is
      // already available).
      directInvoke: {
        hostFsRead: true,
      },
    },
  },
}
```

**Neither config key alone — nor both together — is sufficient.** All three
gates must hold: both config keys AND an owner/admin sender (`senderIsOwner ===
true`, evaluated per request). A non-owner trusted-proxy caller (e.g.
`operator.write`) is refused the **built-in** `read` coding tool even when both
config keys are set — the owner gate scopes only built-in host-FS
materialization; a same-named allowlisted plugin tool, if any, is unaffected and
resolves under the normal `gateway.tools.allow`/`deny` policy (see _Plugin name
collision_ below):

| `tools.allow` includes `"read"` | `directInvoke.hostFsRead` | sender is owner/admin | built-in `read` reachable                                                 |
| ------------------------------- | ------------------------- | --------------------- | ------------------------------------------------------------------------- |
| no                              | no                        | —                     | ❌                                                                        |
| yes                             | no                        | yes                   | ❌ (built-in not materialized; `dangerous_allow` audit fires — see below) |
| no                              | yes                       | yes                   | ❌ (filtered by HTTP deny)                                                |
| yes                             | yes                       | no                    | ❌ (owner gate — built-in not materialized)                               |
| yes                             | yes                       | yes                   | ✅                                                                        |

**Audit behavior:** Setting only `gateway.tools.allow: ["read"]` (without `hostFsRead: true`) does not materialize the built-in `read` tool, but it does remove `read` from the HTTP deny list. Because a plugin tool named `read` could be independently reachable, the config audit fires `gateway.tools_invoke_http.dangerous_allow`. To suppress that warning in favour of the more specific `host_read_allow` finding, set both keys together.

**Plugin name collision:** The owner gate and the dual-key opt-in apply only to
the **built-in** `read` coding tool. For a non-owner caller the built-in is never
materialized, so a same-named tool from an allowlisted plugin (if any) is not
additionally gated by `senderIsOwner` — it resolves under the normal
`gateway.tools.allow`/`deny` policy. When all three gates hold and both a plugin
and the built-in share the name `read`, the built-in takes precedence on the
direct-invoke surface, so the documented filesystem behavior holds regardless of
installed plugins.

**Security:** When enabled, `read` can access any file the gateway process can
open, **outside the configured workspace** unless `tools.fs.workspaceOnly: true`
is set. The config audit (`gateway.tools_invoke_http.host_read_allow`) warns
whenever both keys are set — regardless of `tools.fs.workspaceOnly` — so the
exposure is always visible in audit output; workspace confinement is the
recommended remediation, not a condition that silences the warning.

### Opt-in: coding tools `write` / `edit` over direct-invoke

The host-filesystem write coding tools follow the same gating pattern as `read`.
Each tool name must appear in `gateway.tools.allow` AND the
`directInvoke.hostFsWrite: true` opt-in must be set AND the request must come
from an owner/admin sender (`senderIsOwner === true`, evaluated per request); any
one missing leaves both write tools unreachable. A non-owner trusted-proxy caller
(e.g. `operator.write`) is refused even when both config keys are set.

```json5
{
  gateway: {
    tools: {
      // (1) Per-tool names you want enabled (subset of write/edit).
      allow: ["write", "edit"],
      // (2) Single class-level opt-in for the entire write family.
      directInvoke: {
        hostFsWrite: true,
      },
    },
  },
}
```

Truth table (per tool name `T` ∈ `{write, edit}`):

| `tools.allow` includes `T` | `directInvoke.hostFsWrite` | sender is owner/admin | `T` reachable on direct-invoke                                            |
| -------------------------- | -------------------------- | --------------------- | ------------------------------------------------------------------------- |
| no                         | no                         | —                     | ❌                                                                        |
| yes                        | no                         | yes                   | ❌ (built-in not materialized; `dangerous_allow` audit fires — see below) |
| no                         | yes                        | yes                   | ❌ (filtered by HTTP deny)                                                |
| yes                        | yes                        | no                    | ❌ (owner gate — non-owner refused)                                       |
| yes                        | yes                        | yes                   | ✅                                                                        |

**Audit behavior:** Setting only `gateway.tools.allow: ["write"]` (without `hostFsWrite: true`) does not materialize the built-in `write` tool, but it does remove `write` from the HTTP deny list. Because a plugin tool named `write` could be independently reachable, the config audit fires `gateway.tools_invoke_http.dangerous_allow`. Set both keys together to suppress that in favour of the more specific `host_write_allow` finding.

**Plugin name collision:** When both keys are set, the built-in coding tool takes precedence over any plugin with the same name (`write` or `edit`) on the direct-invoke surface.

**`apply_patch` is NOT in this set.** Although `apply_patch` is in
`DEFAULT_GATEWAY_HTTP_TOOL_DENY` for future-proofing, the coding tool factory
does not currently produce an `apply_patch` entry for the direct-invoke surface.
Including `"apply_patch"` in `gateway.tools.allow` has no effect on built-in
direct-invoke behavior, but it does remove the name from the HTTP deny list and
will trigger `gateway.tools_invoke_http.dangerous_allow` (a same-named plugin
could be reachable). The factory wiring is deferred to a future PR.

**Security:** When enabled, write-class tools can mutate any file the gateway
process can open, **outside the configured workspace** unless
`tools.fs.workspaceOnly: true` is set. Strongly recommend pairing
`directInvoke.hostFsWrite: true` with `tools.fs.workspaceOnly: true`. The
config audit (`gateway.tools_invoke_http.host_write_allow`) warns whenever both
keys are set — regardless of `tools.fs.workspaceOnly` — so the exposure is
always visible in audit output; workspace confinement is the recommended
remediation, not a condition that silences the warning. The finding escalates
from warn to critical when `gateway.bind` is non-loopback.

### NOT yet exposed: `exec` / `process` / `spawn` / `shell`

RCE-class tools (`exec`, `process`, `spawn`, `shell`) remain unavailable on the
direct-invoke surface. They require a distinct owner/admin enforcement model
that is deferred to a separate follow-up PR. The `gateway.tools.allow` knob
alone (even paired with a hypothetical opt-in flag) is insufficient because a
trusted-proxy caller with `operator.write` could otherwise reach them without
operator-level intent.

To help group policies resolve context, you can optionally set:

- `x-openclaw-message-channel: <channel>` (example: `slack`, `telegram`)
- `x-openclaw-account-id: <accountId>` (when multiple accounts exist)
- `x-openclaw-message-to: <target>` (delivery target for message-tool policy)
- `x-openclaw-thread-id: <threadId>` (thread context for message-tool policy)

## Responses

| Status | Meaning                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------- |
| `200`  | `{ ok: true, result }`                                                                         |
| `400`  | `{ ok: false, error: { type, message } }` (invalid request or tool input error)                |
| `401`  | Unauthorized                                                                                   |
| `403`  | `{ ok: false, error: { type, message, requiresApproval? } }` (tool call blocked by policy)     |
| `404`  | Tool not available (not found or not allowlisted)                                              |
| `405`  | Method not allowed                                                                             |
| `408`  | Request body read timed out                                                                    |
| `413`  | Request body exceeded the max payload size                                                     |
| `429`  | Auth rate-limited (`Retry-After` set)                                                          |
| `500`  | `{ ok: false, error: { type, message } }` (unexpected tool execution error; sanitized message) |

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
