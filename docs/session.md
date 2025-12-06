# Session Management

CLAWDIS keeps lightweight session state so your agent can remember context between messages. Sessions are stored in a small JSON file and expire automatically after idle time or when you reset them.

## Where sessions live

- Default path: `~/.clawdis/sessions.json` (legacy: `~/.warelay/sessions.json`).
- Override with `inbound.reply.session.store` in your config if you want a custom location.
- The file is a plain map of `sessionKey -> { sessionId, updatedAt, ... }`; it is safe to delete if you want a full reset.

## How session keys are chosen

- Direct chats: by default collapse to the canonical key `main` so all 1:1 channels (WhatsApp, WebChat, Telegram) share a single session.
- Group chats: `group:<whatsapp-jid>` so group history stays isolated from DMs.
- Global mode: set `inbound.reply.session.scope = "global"` to force a single shared session for all chats.
- Unknown senders fall back to `unknown`.

To change the canonical key (or disable collapsing), set `inbound.reply.session.mainKey` to another string or leave it empty.

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
        store: "~/state/clawdis-sessions.json", // optional custom path
        mainKey: "main"             // canonical direct-chat bucket
      }
    }
  }
}

## Surfaces (channel labels)

Each inbound message can carry a `Surface` hint in the templating context (e.g., `whatsapp`, `webchat`, `telegram`, `voice`). Routing stays deterministic: replies are sent back to the origin surface, but the shared `main` session keeps context unified across direct channels. Groups retain their `group:<jid>` buckets.

## WebChat history

WebChat always attaches to the `main` session and hydrates the full Tau JSONL transcript from `~/.clawdis/sessions/<SessionId>.jsonl`, so desktop view reflects all turns, even those that arrived via WhatsApp/Telegram.
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
