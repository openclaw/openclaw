# Session Management

Clawdis treats **one session as primary**. By default the canonical key is `main`; set `inbound.reply.session.mainKey` to change it. Older/local sessions can stay on disk, but only the primary key is used for desktop/web chat and direct agent calls.

## Where state lives
- Store file: `~/.clawdis/sessions/sessions.json` (legacy: `~/.clawdis/sessions.json`).
- Transcripts: `~/.clawdis/sessions/<SessionId>.jsonl` (one file per session id).
- The store is a map `sessionKey -> { sessionId, updatedAt, ... }`. Deleting entries is safe; they are recreated on demand.

## Mapping transports → session keys
- Direct chats (WhatsApp, Telegram, desktop Web Chat) all collapse to the **primary key** so they share context.
- Multiple phone numbers can map to that same key; they act as transports into the same conversation.
- Group chats still isolate state with `group:<jid>` keys; do not reuse the primary key for groups.

## Lifecyle
- Idle expiry: `inbound.reply.session.idleMinutes` (default 60). After the timeout a new `sessionId` is minted on the next message.
- Reset triggers: exact `/new` (plus any extras in `resetTriggers`) start a fresh session id and pass the remainder of the message through.
- Manual reset: delete specific keys from the store or remove the JSONL transcript; the next message recreates them.

## Configuration (primary-only example)
```json5
// ~/.clawdis/clawdis.json
{
  inbound: {
    reply: {
      session: {
        scope: "per-sender",      // keep group keys separate
        idleMinutes: 120,
        resetTriggers: ["/new"],
        store: "~/.clawdis/sessions/sessions.json",
        mainKey: "main"           // marks the primary session
      }
    }
  }
}
```

## Inspecting
- `pnpm clawdis status` — shows store path and recent sessions.
- `pnpm clawdis sessions --json` — dumps every entry (filter with `--active <minutes>`).
- JSONL transcripts can be opened directly to review full turns.

## Tips
- Keep the primary key dedicated to 1:1 traffic; let groups keep their own keys.
- When automating cleanup, delete individual keys instead of the whole store to preserve context elsewhere.
