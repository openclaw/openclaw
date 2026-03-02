---
summary: "Cross-channel identity verification and per-user scoped memory retrieval"
read_when:
  - Setting up user identity and memory scoping
  - Deploying with the auth-memory-gate plugin stack
  - Understanding how identity flows through the plugin chain
title: "Identity-Scoped Memory"
---

# Identity-Scoped Memory

OpenClaw's identity-scoped memory system lets you deploy an agent that:

1. **Gates conversation** until users identify themselves
2. **Links channel identities** (WhatsApp number, Slack ID, web session) to a single canonical user
3. **Scopes memory retrieval** so each user's knowledge graph is isolated and follows them across channels

## Architecture

Four plugins work together in a priority-ordered hook chain:

```
  Message arrives on any channel (WhatsApp, Slack, /chat, web)
  │
  ▼
┌─────────────────────────────────────────────────────┐
│  persist-user-identity (priority 60)                │
│  Resolves channel + peer ID → canonical user        │
│  Injects [USER_IDENTITY] block into context         │
│  Commands: /verify, /register, /whoami              │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  persist-postgres (priority 50)                     │
│  Persists message to lp_messages table              │
│  Links conversation to session key                  │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  auth-memory-gate (priority 40)                     │
│  Checks identity status:                            │
│    - Not found → hard gate (ask for /verify)        │
│    - Found     → inject [MEMORY_SCOPE] with key     │
│  Safety net: message_sending hook appends CTA       │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│  memory-graphiti (priority 0)                       │
│  Uses scope_key as Graphiti group_id                │
│  Auto-recall: injects relevant facts before turn    │
│  Auto-capture: stores conversation after turn       │
└─────────────────────────────────────────────────────┘
```

## User Flow

### New user (not registered)

```
User: "Hello, I'd like to check my treatment plan"

Agent: "Welcome! Before I can help you, I need to verify your identity.
        Please type: /verify <token>
        (where <token> is your authorization token from the app)

        If you don't have a token, you can register with:
        /register <first_name> <last_name>"
```

The agent will not answer any questions or engage in conversation until the
user identifies themselves. This is enforced by the hard gate system prompt
and the message_sending safety net.

### User verifies with token

```
User: /verify eyJhbGciOiJIUzI1NiJ9...

Agent: "Identity verified! Welcome, Jane Doe.
        Your user ID: 6a0c0211-a497-...
        Linked channels: whatsapp:+1234567890"
```

The JWT `sub` claim becomes the `external_id`. All channels linked to this
user now share the same memory scope.

### User registers without token (guest)

```
User: /register Jane Doe

Agent: "Registered as Jane Doe.
        Your user ID: 6a0c0211-a497-...
        Tip: Use /verify <token> to link your app account for cross-channel access."
```

This creates a channel-only identity. The user can chat normally and their
conversations are captured in a per-user knowledge graph. They can upgrade
to a verified identity later by running `/verify <token>` from any channel.

### Returning user (already registered)

On subsequent messages, `persist-user-identity` finds the existing user by
channel + peer ID. The hard gate is skipped, `auth-memory-gate` injects the
memory scope, and `memory-graphiti` recalls relevant facts from their personal
knowledge graph.

## Cross-Channel Linking

When a verified user chats from a new channel, their identity is automatically
linked:

```
WhatsApp: +1234567890  ─┐
Slack:    U_ABC123      ─┼─→ lp_users.id = 6a0c0211 (external_id = "auth0|jane")
Web chat: session_xyz   ─┘     │
                                ▼
                          One knowledge graph
                          (Graphiti group_id = "auth0|jane")
```

Each channel's peer ID is stored in `lp_user_channels`. The `external_id`
(from the JWT `sub` claim) is the cross-channel key that unifies memory.

## Configuration

### Environment Variables

| Variable         | Required | Description                                            |
| ---------------- | -------- | ------------------------------------------------------ |
| `DATABASE_URL`   | Yes      | PostgreSQL connection string (shared by all 4 plugins) |
| `GETZEP_API_KEY` | Optional | Zep Cloud API key for memory-graphiti                  |

### Plugin Config (openclaw.json)

```json
{
  "plugins": {
    "entries": {
      "persist-postgres": {
        "enabled": true
      },
      "persist-user-identity": {
        "enabled": true,
        "config": {
          "auth": {
            "mode": "jwt-hs256",
            "jwtSecret": "your-jwt-secret"
          }
        }
      },
      "auth-memory-gate": {
        "enabled": true,
        "config": {
          "hardGate": true,
          "requireVerified": false
        }
      },
      "memory-graphiti": {
        "enabled": true,
        "config": {
          "groupIdStrategy": "identity",
          "autoCapture": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

### Config Options

#### auth-memory-gate

| Option            | Type    | Default | Description                                                 |
| ----------------- | ------- | ------- | ----------------------------------------------------------- |
| `hardGate`        | boolean | `false` | Lock agent to verification-only mode for unidentified users |
| `requireVerified` | boolean | `false` | Gate memory behind verified (token-linked) identity         |
| `gateMessage`     | string  | —       | Custom message for soft-gated users                         |

#### persist-user-identity

| Option           | Type   | Default | Description                          |
| ---------------- | ------ | ------- | ------------------------------------ |
| `auth.mode`      | string | —       | `"jwt-hs256"` or `"verify-endpoint"` |
| `auth.jwtSecret` | string | —       | HMAC secret for JWT verification     |
| `auth.issuer`    | string | —       | Expected JWT `iss` claim (optional)  |
| `auth.audience`  | string | —       | Expected JWT `aud` claim (optional)  |

#### memory-graphiti

| Option            | Type    | Default            | Description                           |
| ----------------- | ------- | ------------------ | ------------------------------------- |
| `groupIdStrategy` | string  | `"channel-sender"` | Set to `"identity"` for cross-channel |
| `autoCapture`     | boolean | `true`             | Store conversations after each turn   |
| `autoRecall`      | boolean | `true`             | Inject facts before each turn         |
| `maxFacts`        | number  | `10`               | Max facts per recall                  |

## Database Schema

All plugins share the `lp_` table prefix in the same PostgreSQL database:

```sql
-- persist-user-identity
lp_users (id UUID PK, external_id VARCHAR UNIQUE, first_name, last_name, ...)
lp_user_channels (id UUID PK, user_id FK → lp_users, channel, channel_peer_id, UNIQUE(channel, channel_peer_id))

-- persist-postgres
lp_conversations (id UUID PK, session_key, channel, ...)
lp_messages (id UUID PK, conversation_id FK → lp_conversations, role, content, ...)
```

## Deployment

### Railway

The `scripts/railway-entrypoint.sh` auto-generates an `openclaw.json` with all
four plugins enabled and `hardGate: true` by default. Set `DATABASE_URL` in the
Railway dashboard and deploy.

See the [Railway deployment guide](/install/railway) for full setup instructions.

## Plugin Documentation

| Plugin                | Docs                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| persist-user-identity | [IDENTITY_CONTRACT.md](/extensions/persist-user-identity/IDENTITY_CONTRACT.md)                                                         |
| auth-memory-gate      | [README.md](/extensions/auth-memory-gate/README.md), [MEMORY_SCOPE_CONTRACT.md](/extensions/auth-memory-gate/MEMORY_SCOPE_CONTRACT.md) |
| memory-graphiti       | [README.md](/extensions/memory-graphiti/README.md)                                                                                     |
| persist-postgres      | [openclaw.plugin.json](/extensions/persist-postgres/openclaw.plugin.json)                                                              |
