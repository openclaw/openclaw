---
summary: "Current agent integration: Pi as the sole coding agent with config examples"
read_when:
  - Changing agent invocation or defaults
---
<!-- {% raw %} -->
# Agent Integration 🤖

CLAWDIS ships with a single coding-agent path: **Pi** (RPC mode). Legacy Claude/Codex/Gemini/Opencode integrations have been removed.

## Default behavior

If you don’t configure `inbound.reply`, CLAWDIS uses the bundled Pi binary in RPC mode:
- command: `pi --mode rpc {{BodyStripped}}`
- per-sender sessions (stored under `~/.clawdis/sessions/*.jsonl`)
- `/new` starts a fresh session

This is usually enough for a personal assistant setup; add `inbound.allowFrom` to restrict who can trigger it.

## Custom agent command (still Pi)

To override the agent command, configure `inbound.reply.mode: "command"`:

```json5
{
  inbound: {
    reply: {
      mode: "command",
      command: ["pi", "--mode", "rpc", "{{BodyStripped}}"],
      timeoutSeconds: 1800,
      agent: { kind: "pi", format: "json" }
    }
  }
}
```

Notes:
- CLAWDIS forces `--mode rpc` for Pi invocations (even if you pass `--mode json/text`).
- If your `command` array omits `{{Body}}`/`{{BodyStripped}}`, CLAWDIS still synthesizes the prompt body for RPC mode.

## Sessions

Session behavior lives under `inbound.reply.session`:

```json5
{
  inbound: {
    reply: {
      session: {
        scope: "per-sender",
        resetTriggers: ["/new", "/reset"],
        idleMinutes: 10080,
        sendSystemOnce: true,
        sessionIntro: "You are Clawd. Be a good lobster."
      }
    }
  }
}
```

Defaults when `session` is enabled:
- Session files are written to `~/.clawdis/sessions/{{SessionId}}.jsonl`.
- Resume adds `--continue` automatically (Pi needs it to load prior messages).

## Heartbeats

If you enable `inbound.reply.heartbeatMinutes`, CLAWDIS periodically runs a heartbeat prompt (default: `HEARTBEAT /think:high`).

- If the agent replies with `HEARTBEAT_OK` (exact token), CLAWDIS suppresses outbound delivery for that heartbeat.
- If you want a different command for heartbeats, set `inbound.reply.heartbeatCommand`.

```json5
{
  inbound: {
    reply: {
      heartbeatMinutes: 30,
      heartbeatCommand: ["pi", "--mode", "rpc", "HEARTBEAT /think:high"]
    }
  }
}
```

## Tool streaming (RPC)

RPC mode emits structured tool lifecycle events (start/result) and assistant output. These are:
- logged to `/tmp/clawdis/…`
- streamed over the Gateway WS to clients like WebChat and the macOS app

## Browser helpers

If you enable the clawd-managed browser (default on), the agent can use:
- `clawdis browser status` / `tabs` / `open <url>` / `screenshot [targetId]`

This uses a dedicated Chrome/Chromium profile (lobster-orange by default) so it doesn’t interfere with your daily browser.

---

*Next: [Group Chats](./group-messages.md)* 🦞
<!-- {% endraw %} -->
