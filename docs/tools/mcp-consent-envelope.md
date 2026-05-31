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

Mark a tool _act-tier_ — return the consent envelope on the first call — when
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

1. Calls the tool with the original input. If the response is an ordinary tool
   result (no consent envelope), returns it to the agent unchanged — the tool
   receives its full argument set including any parameter named
   `confirmation_token`.
2. Detects the envelope. If absent, the result passes through verbatim.
3. Issues a [plugin-style approval](/cli/approvals) through the gateway. The
   user sees a chat message ending with
   `Reply with: /approve <id> allow-once|deny`.
4. Blocks the agent's tool call until the reply lands on the trusted channel,
   the deadline elapses, or the gateway is unavailable.
5. On `allow-once`: re-calls the tool with `confirmation_token = action_id`
   set on the input (replacing any model-supplied value). Returns that second
   result to the agent.
6. On `deny`, expiry, or error: returns a synthetic
   `{ok:false, approved:false, reason}` result. The original `action_id` is
   **never** included in anything the agent sees.

## What the MCP server is responsible for

- Issue an `action_id` per call. Single-use, server-side TTL-bounded
  (`expires_in_seconds` hints OpenClaw at the deadline, but the server is
  the authority). When omitted, OpenClaw uses a 5-minute default that
  matches the realistic notification → unlock → context → reply latency on
  mobile reply channels (WhatsApp/Telegram/SMS). Hard ceiling: 10 min.
- Reject the second call if `confirmation_token` doesn't match the issued
  `action_id`, or has been redeemed already, or has expired.
- Audit `action_id`s server-side, ideally with the originating channel /
  agent / session metadata OpenClaw passed in the approval payload.

## Trust boundary

Without the consent envelope, the trust gate for any state-changing MCP tool
call is _the model deciding to call it_. With it, the gate is **the user's
explicit `/approve` reply on a channel that authenticates the sender**.

The model never sees `action_id`. It cannot self-approve by echoing it back,
because `action_id` is redacted from every result the agent sees. On the
re-call, OpenClaw supplies `confirmation_token` itself, replacing any
model-supplied value — so even if a model fabricates a token, the server
receives the real `action_id` instead. As a final layer, the MCP server's
own single-use redemption check rejects any token that doesn't match a
pending action.

This is the same pattern OpenClaw already enforces for shell exec via
[`exec-approvals`](/tools/exec-approvals): the _agent_ asks, the _user_
authorises, the _runtime_ executes.

## Configuration

Approval gating is on by default. To disable it for a deployment (e.g.
single-user CI runs where there is no human in the loop), set:

```jsonc
// openclaw.json
{
  "mcp": {
    "approvals": { "enabled": false },
  },
}
```

When disabled, MCP tools that return the envelope pass through verbatim;
the model receives `requires_confirmation: true` and decides what to do.

### Wait window

When the envelope omits `expires_in_seconds`, OpenClaw waits up to 5 min
(300_000 ms) by default for a `/approve` reply — tuned for mobile reply
channels (WhatsApp/Telegram/SMS) where notification → unlock → context →
tap is realistically 60–180 s. Override:

```jsonc
{
  "mcp": {
    "approvals": { "defaultTimeoutMs": 240000 },
  },
}
```

The value is clamped to `[1000, 600000]` ms. Envelope-supplied
`expires_in_seconds` always wins when present, and is also capped at
10 min.

## Reference servers

The HomeBrain integrations module is a working reference implementation —
see `scripts/mcp_common.py` and `scripts/mcp-vault.py` /
`scripts/mcp-nextcloud.py` / `scripts/mcp-email.py` in
[oalterg/HomeBrain](https://github.com/oalterg/HomeBrain). The shared
`Consent` helper there issues + redeems tokens with TTL, single-use, and
chat-id scoping.
