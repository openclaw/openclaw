---
summary: "Channel-mediated user approval for MCP tool calls that mutate state"
read_when:
  - Building an MCP server that exposes act-tier (mutating) tools
  - Wiring third-party MCP servers into OpenClaw and want them gated like /approve does for shell exec
  - Auditing the trust boundary for agent-driven actions
title: "MCP consent envelope"
sidebarTitle: "MCP consent envelope"
---

When an MCP tool can change state outside OpenClaw — sending an email, rotating a
password, creating a calendar event — the model should not be the only thing
standing between the user and the action. OpenClaw lets MCP servers opt into
**channel-mediated approval** by returning a small, standard JSON envelope
instead of a normal tool result. OpenClaw recognises the envelope, suppresses
the result, and asks the user to approve through the same `/approve <id>`
pipeline that backs shell-exec approvals.

This page describes the contract MCP servers implement and the runtime
behaviour OpenClaw guarantees.

## When to use it

Mark a tool *act-tier* — return the consent envelope on the first call — when
running it without explicit user approval would be hard to undo or visible to
third parties. Examples: send/forward email, write to a vault, change a
smart-home automation, post to a chat. Reads (search, list, get) should not
return the envelope; they pass through verbatim.

## The envelope

Return one of the two shapes from `tools/call`. Either works; OpenClaw
inspects both:

```jsonc
// Option A: top-level in structuredContent (preferred — it's the typed slot)
{
  "structuredContent": {
    "ok": false,
    "requires_confirmation": true,
    "action_id": "<server-side single-use token>",
    "summary": "<one-line description of what the tool will do>",
    "expires_in_seconds": 60         // optional TTL hint
  },
  "isError": false,
  "content": []
}

// Option B: JSON inside content[0].text — easiest for stdio servers
{
  "content": [{
    "type": "text",
    "text": "{\"ok\":false,\"requires_confirmation\":true,\"action_id\":\"...\",\"summary\":\"...\"}"
  }],
  "isError": false
}
```

Required: `requires_confirmation: true` and a non-empty `action_id`.
Recommended: a short, user-readable `summary`.

## What OpenClaw does

1. Strips any model-supplied `confirmation_token` from the input *before* the
   first call. Only the consent path is allowed to set it.
2. Calls the tool. If the response is an ordinary tool result, returns it to
   the agent unchanged.
3. Detects the envelope. If absent, the result passes through verbatim.
4. Issues a [plugin-style approval](/cli/approvals) through the gateway. The
   user sees a chat message ending with
   `Reply with: /approve <id> allow-once|allow-always|deny`.
5. Blocks the agent's tool call until the reply lands on the trusted channel,
   the deadline elapses, or the gateway is unavailable.
6. On `allow-once` / `allow-always`: re-calls the tool with
   `confirmation_token = action_id` set on the input. Returns that second
   result to the agent.
7. On `deny`, expiry, or error: returns a synthetic `{ok:false, approved:false,
   reason}` result. The original `action_id` is **never** included in
   anything the agent sees.

## What the MCP server is responsible for

* Issue an `action_id` per call. Single-use, server-side TTL-bounded
  (`expires_in_seconds` hints OpenClaw at the deadline, but the server is
  the authority).
* Reject the second call if `confirmation_token` doesn't match the issued
  `action_id`, or has been redeemed already, or has expired.
* Audit `action_id`s server-side, ideally with the originating channel /
  agent / session metadata OpenClaw passed in the approval payload.

## Trust boundary

Without the consent envelope, the trust gate for any state-changing MCP tool
call is *the model deciding to call it*. With it, the gate is **the user's
explicit `/approve` reply on a channel that authenticates the sender**.

The model never sees `action_id`. It cannot self-approve by echoing it back,
because OpenClaw scrubs `confirmation_token` from the model's input on the
first call and supplies it itself on the second call after the user has
replied. Even if a malicious or careless agent crafts a fake token, the MCP
server's own redemption check rejects it.

This is the same pattern OpenClaw already enforces for shell exec via
[`exec-approvals`](/tools/exec-approvals): the *agent* asks, the *user*
authorises, the *runtime* executes.

## Configuration

Approval gating is on by default. To disable it for a deployment (e.g.
single-user CI runs where there is no human in the loop), set:

```jsonc
// openclaw.json
{
  "mcp": {
    "approvals": { "enabled": false }
  }
}
```

When disabled, MCP tools that return the envelope pass through verbatim;
the model receives `requires_confirmation: true` and decides what to do.

## Reference servers

The HomeBrain integrations module is a working reference implementation —
see `scripts/mcp_common.py` and `scripts/mcp-vault.py` /
`scripts/mcp-nextcloud.py` / `scripts/mcp-email.py` in
[oalterg/HomeBrain](https://github.com/oalterg/HomeBrain). The shared
`Consent` helper there issues + redeems tokens with TTL, single-use, and
chat-id scoping.
