---
summary: "Session management rules, keys, and persistence for chats"
read_when:
  - Modifying session handling or storage
---
# Session Management

Clawdis treats **one session as primary**. By default the canonical key is `main` for every direct chat; no configuration is required. You can rename it via `inbound.session.mainKey` if you really want, but there is still only a single primary session. Older/local sessions can stay on disk, but only the primary key is used for desktop/web chat and direct agent calls.

## Gateway is the source of truth
All session state is **owned by the gateway** (the “master” Clawdis). UI clients (macOS app, WebChat, etc.) must query the gateway for session lists and token counts instead of reading local files.

- In **remote mode**, the session store you care about lives on the remote gateway host, not your Mac.
- Token counts shown in UIs come from the gateway’s store fields (`inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`). Clients do not parse JSONL transcripts to “fix up” totals.

## Where state lives
- On the **gateway host**:
  - Store file: `~/.clawdis/sessions/sessions.json` (legacy: `~/.clawdis/sessions.json`).
  - Transcripts: `~/.clawdis/sessions/<SessionId>.jsonl` (one file per session id).
- The store is a map `sessionKey -> { sessionId, updatedAt, ... }`. Deleting entries is safe; they are recreated on demand.
- Clawdis does **not** read legacy Pi/Tau session folders.

## Mapping transports → session keys
- Direct chats (WhatsApp, Telegram, desktop Web Chat) all collapse to the **primary key** so they share context.
- Multiple phone numbers can map to that same key; they act as transports into the same conversation.
- Group chats still isolate state with `group:<jid>` keys; do not reuse the primary key for groups.

## Lifecyle
- Idle expiry: `inbound.session.idleMinutes` (default 60). After the timeout a new `sessionId` is minted on the next message.
- Reset triggers: exact `/new` or `/reset` (plus any extras in `resetTriggers`) start a fresh session id and pass the remainder of the message through. If `/new` or `/reset` is sent alone, Clawdis runs a short “hello” greeting turn to confirm the reset.
- Manual reset: delete specific keys from the store or remove the JSONL transcript; the next message recreates them.

## Configuration (optional rename example)
```json5
// ~/.clawdis/clawdis.json
{
  inbound: {
    session: {
      scope: "per-sender",      // keep group keys separate
      idleMinutes: 120,
      resetTriggers: ["/new", "/reset"],
      store: "~/.clawdis/sessions/sessions.json",
      mainKey: "main"           // optional rename; still a single primary
    }
  }
}
```

## Inspecting
- `pnpm clawdis status` — shows store path and recent sessions.
- `pnpm clawdis sessions --json` — dumps every entry (filter with `--active <minutes>`).
- `pnpm clawdis gateway call sessions.list --params '{}'` — fetch sessions from the running gateway (use `--url`/`--token` for remote gateway access).
- Send `/status` in chat to see whether the agent is reachable, how much of the session context is used, current thinking/verbose toggles, and when your WhatsApp web creds were last refreshed (helps spot relink needs).
- JSONL transcripts can be opened directly to review full turns.

## Tips
- Keep the primary key dedicated to 1:1 traffic; let groups keep their own keys.
- When automating cleanup, delete individual keys instead of the whole store to preserve context elsewhere.
