# @openclaw/memory-graphiti

Graph-based knowledge memory plugin for OpenClaw using [Graphiti](https://github.com/getzep/graphiti) — a temporally-aware knowledge graph framework.

Supports two backends:

- **Zep Cloud** (managed) — uses `@getzep/zep-cloud` SDK with API key
- **Self-hosted Graphiti** — raw REST API calls to a user-managed Graphiti server

## Quick Start: Zep Cloud (Recommended)

1. Get an API key at [app.getzep.com](https://app.getzep.com)
2. Set the environment variable:
   ```bash
   export GETZEP_API_KEY=z_your_key_here
   ```
3. Configure the plugin:
   ```json
   {
     "plugins": {
       "slots": { "memory": "memory-graphiti" },
       "config": {
         "memory-graphiti": {
           "apiKey": "${GETZEP_API_KEY}"
         }
       }
     }
   }
   ```

That's it. Zep Cloud handles Neo4j, entity extraction, and LLM processing.

## Quick Start: Self-Hosted Graphiti

### Prerequisites

A running Graphiti REST API server backed by Neo4j:

```bash
git clone https://github.com/getzep/graphiti.git
cd graphiti
cp .env.example .env
# Set OPENAI_API_KEY (required for entity extraction)
docker compose up -d
```

Verify: `curl http://localhost:8000/healthcheck`

### Configuration

```json
{
  "plugins": {
    "slots": { "memory": "memory-graphiti" },
    "config": {
      "memory-graphiti": {
        "serverUrl": "${GRAPHITI_SERVER_URL}"
      }
    }
  }
}
```

## Configuration Reference

| Option            | Type                                                            | Default            | Description                                                                 |
| ----------------- | --------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `apiKey`          | string                                                          | —                  | Zep Cloud API key. When set, uses Zep Cloud backend.                        |
| `serverUrl`       | string                                                          | —                  | Self-hosted Graphiti REST API URL. Used when apiKey is not set.             |
| `userId`          | string                                                          | —                  | Fixed Zep Cloud user ID. If not set, derived from group ID strategy.        |
| `groupIdStrategy` | `"channel-sender"` \| `"session"` \| `"static"` \| `"identity"` | `"channel-sender"` | How to partition the knowledge graph.                                       |
| `staticGroupId`   | string                                                          | —                  | Required when strategy is `"static"`.                                       |
| `databaseUrl`     | string                                                          | —                  | PostgreSQL URL for `"identity"` strategy. Falls back to `DATABASE_URL` env. |
| `autoCapture`     | boolean                                                         | `true`             | Capture conversations after each agent turn.                                |
| `autoRecall`      | boolean                                                         | `true`             | Inject relevant facts before each agent turn.                               |
| `maxFacts`        | number (1–100)                                                  | `10`               | Max facts to inject during auto-recall.                                     |

**Backend auto-detection**: If `apiKey` is set → Zep Cloud. Otherwise → self-hosted Graphiti REST API.

All string config values support `${ENV_VAR}` syntax for environment variable resolution.

### Group ID Strategies

- **`channel-sender`** (default): Partitions by `{provider}:{senderId}`. Each user gets their own knowledge graph per messaging channel. No cross-channel continuity.
- **`session`**: Uses the full session key. Each conversation thread gets its own graph.
- **`static`**: All conversations share a single graph identified by `staticGroupId`.
- **`identity`** (recommended with auth stack): Uses the canonical user ID from `persist-user-identity`'s database. Verified users share one graph across all channels; channel-only users get per-user isolation. Requires `DATABASE_URL` or `databaseUrl` config.

In Zep Cloud mode, the group ID maps to a Zep Cloud `userId`. Users are auto-created on first interaction.

### Identity Strategy — Cross-Channel Memory

The `identity` strategy integrates with the identity plugin stack to provide **per-user memory that follows users across channels**:

```
WhatsApp user +1234567890  ─┐
Slack user U_ABC123        ─┼─ same person (linked via /verify) → one knowledge graph
Web chat session xyz       ─┘
```

**How it works:**

1. `persist-user-identity` resolves the channel peer ID to a canonical `user_id`
2. `auth-memory-gate` derives a `scope_key` (preferring `external_id` for verified users)
3. `memory-graphiti` reads the `scope_key` from the identity DB and uses it as the Graphiti `group_id`

**Required plugins** (in priority order):
| Plugin | Priority | Role |
| ----------------------- | -------- | --------------------------------- |
| `persist-user-identity` | 60 | Resolves user from channel + peer |
| `persist-postgres` | 50 | Persists messages |
| `auth-memory-gate` | 40 | Derives scope key, gates access |
| `memory-graphiti` | 0 | Recalls/captures scoped memories |

**Configuration example:**

```json
{
  "plugins": {
    "entries": {
      "persist-user-identity": { "enabled": true },
      "persist-postgres": { "enabled": true },
      "auth-memory-gate": {
        "enabled": true,
        "config": { "hardGate": true }
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

All plugins share `DATABASE_URL` for PostgreSQL access. Set it as an environment variable or in each plugin's `databaseUrl` config.

## How It Works

### Auto-Capture (`agent_end` hook)

After each agent turn, the plugin extracts user and assistant messages and sends them to the knowledge graph. The backend asynchronously processes them — extracting entities, relationships, and temporal facts.

### Auto-Recall (`before_agent_start` hook)

Before each agent turn, the plugin searches the knowledge graph for facts relevant to the user's prompt and injects them as context via `prependContext`.

### Agent Tools

- **`graphiti_search`** — Search the knowledge graph for facts by natural language query.
- **`graphiti_episodes`** — Retrieve recent conversation episodes stored in the graph.

### CLI

```bash
openclaw graphiti status   # Check server/API connectivity
```

## Development

```bash
# Unit tests
pnpm vitest run extensions/memory-graphiti/index.test.ts

# Integration tests (requires GETZEP_API_KEY)
GETZEP_API_KEY=<key> pnpm vitest run extensions/memory-graphiti/integration.test.ts
```
