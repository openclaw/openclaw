# Session Management

CLAWDIS keeps lightweight session state so your agent can remember context between messages. Sessions are stored in a small JSON file and expire automatically after idle time or when you reset them.

## Where sessions live

- Default path: `~/.clawdis/sessions.json` (legacy: `~/.warelay/sessions.json`).
- Override with `inbound.reply.session.store` in your config if you want a custom location.
- The file is a plain map of `sessionKey -> { sessionId, updatedAt, ... }`; it is safe to delete if you want a full reset.

## How session keys are chosen

- Direct chats: normalized E.164 sender number (e.g., `+15551234567`).
- Group chats: `group:<whatsapp-jid>` so group history stays isolated from DMs.
- Global mode: set `inbound.reply.session.scope = "global"` to force a single shared session for all chats.
- Unknown senders fall back to `unknown`.

## When sessions reset

- Idle timeout: `inbound.reply.session.idleMinutes` (default 60). If no messages arrive within this window, a new `sessionId` is created on the next message.
- Reset triggers: `inbound.reply.session.resetTriggers` (default `['/new']`). Sending exactly `/new` or `/new <text>` starts a fresh session and passes the remaining text to the agent.
- Manual nuke: delete the store file or remove specific keys with `jq`/your editor; a new file is created on the next message.

## Configuration recap

```json5
// ~/.clawdis/clawdis.json
{
  inbound: {
    reply: {
      session: {
        scope: "per-sender",      // or "global"
        resetTriggers: ["/new"],   // additional triggers allowed
        idleMinutes: 120,           // extend or shrink timeout (min 1)
        store: "~/state/clawdis-sessions.json" // optional custom path
      }
    }
  }
}
```

Other session-related behaviors:
- `thinkingLevel` and `verboseLevel` persist per session so inline directives stick until the session resets.
- Heartbeats reuse the existing session for a recipient when available (good for keeping context warm).

## Inspecting sessions

- `clawdis status` shows the session store path, total count, and the five most recent keys with ages.
- `clawdis sessions` lists every session (filter with `--active <minutes>` or use `--json` for scripts). It also reports token usage per session; set `inbound.reply.agent.contextTokens` to see the budget percentage (defaults to ~200k tokens for Opus 4.5 via pi-ai defaults).
- For a deeper look, open the JSON store directly; the keys match the rules above.

## Tips

- Keep groups isolated: mention-based triggers plus the `group:<jid>` session key prevent group traffic from contaminating your DM history.
- If you automate cleanup, prefer deleting specific keys instead of the whole file to keep other conversations intact.
