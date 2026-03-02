# @openclaw/auth-memory-gate

Identity-scoped memory retrieval gate for OpenClaw. Reads user identity from
[persist-user-identity](../persist-user-identity)'s database and controls
access to downstream memory plugins (Graphiti, LanceDB, pgvector).

## What It Does

This plugin sits between identity resolution and memory retrieval in the hook
chain. It determines **who** is chatting and decides **whether** they can access
scoped memories:

```
Message arrives
  │
  ▼
persist-user-identity (priority 60)  →  resolves user from channel + peer ID
  │
persist-postgres (priority 50)       →  persists message to database
  │
auth-memory-gate (priority 40)       →  checks identity, injects scope or gate
  │
memory-graphiti (priority 0)         →  recalls memories scoped to user
```

### Hard Gate Mode (Recommended for Production)

When `hardGate: true`, the agent is **locked to verification-only conversation**
until the user identifies themselves:

1. **Unregistered user sends a message** — the agent greets them and asks for
   identity verification. It will not answer questions or engage in conversation.
2. **User provides a token** (`/verify <token>`) — the plugin validates the JWT,
   links the channel identity to the verified user, and clears the gate. The
   agent now has full access to the user's scoped memories.
3. **User registers without a token** (`/register Jane Doe`) — creates a
   channel-only identity. The gate clears, but memories are scoped to this
   channel only (no cross-channel continuity).
4. **User upgrades later** — a channel-only user can run `/verify <token>` at
   any time to link their app account. Existing channel history is preserved.

### Soft Gate Mode

When `hardGate: false` and `requireVerified: true`, the agent can converse
normally but memory retrieval is blocked until the user verifies. This is useful
when you want to allow general conversation but restrict personalized memory
recall.

## Configuration

```json
{
  "plugins": {
    "entries": {
      "auth-memory-gate": {
        "enabled": true,
        "config": {
          "hardGate": true,
          "requireVerified": false
        }
      }
    }
  }
}
```

| Option            | Type    | Default | Description                                                  |
| ----------------- | ------- | ------- | ------------------------------------------------------------ |
| `databaseUrl`     | string  | —       | PostgreSQL URL. Falls back to `DATABASE_URL` env var.        |
| `hardGate`        | boolean | `false` | Lock agent to verification-only mode for unidentified users. |
| `requireVerified` | boolean | `false` | Gate memory behind verified (token-linked) identity.         |
| `gateMessage`     | string  | —       | Custom message for soft-gated users.                         |

## Required Plugins

This plugin reads from the database tables created by `persist-user-identity`.
Both plugins must share the same `DATABASE_URL`:

| Plugin                  | Required | Why                                        |
| ----------------------- | -------- | ------------------------------------------ |
| `persist-user-identity` | Yes      | Creates `lp_users` + `lp_user_channels`    |
| `persist-postgres`      | Yes      | Creates `lp_conversations` + `lp_messages` |
| `memory-graphiti`       | Optional | Downstream memory with `identity` strategy |

## How the Gate Works

### Identity Resolution

On each incoming message, the plugin queries `lp_users` joined with
`lp_user_channels` to find the canonical user for the current channel + peer ID.

- **Found + verified** → injects `[MEMORY_SCOPE]` with `scope_key` = `external_id`
- **Found + unverified** → injects `[MEMORY_SCOPE]` with `scope_key` = `user_id`
  (or gates if `requireVerified: true`)
- **Not found** → injects `[IDENTITY_GATE]` if `hardGate: true`, or returns
  empty (soft pass) if not

### Safety Net (message_sending hook)

When `hardGate: true`, a `message_sending` hook (priority 30) tracks gated peers
in memory. If the LLM ignores the system prompt and responds normally to a gated
user, the hook appends a verification CTA to the outgoing message.

### Context Blocks

Downstream plugins parse these blocks from `prependContext`:

**Memory scope** (when user is identified):

```
[MEMORY_SCOPE]
scope_key: <external_id or user_id>
user_id: <uuid>
external_id: <string|none>
verified: <true|false>
gated: false
[/MEMORY_SCOPE]
```

**Identity gate** (when user is unidentified and `hardGate: true`):

```
[IDENTITY_GATE]
status: LOCKED
channel: <channel>
channel_peer_id: <peer_id>
[/IDENTITY_GATE]
```

## Downstream Integration

See [MEMORY_SCOPE_CONTRACT.md](./MEMORY_SCOPE_CONTRACT.md) for the full
downstream contract including code patterns for Graphiti, LanceDB, and pgvector.

## Development

```bash
# Unit tests
pnpm test extensions/auth-memory-gate

# Type check
pnpm tsgo
```
