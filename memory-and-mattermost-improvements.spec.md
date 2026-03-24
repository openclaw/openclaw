# Rewritten Specs: OpenClaw + Mem0 + Mattermost

This document rewrites the original three specs to align with the selected architecture:

- OpenClaw Gateway is the source of truth for sessions.
- Long-term memory uses the official `@mem0/openclaw-mem0` plugin in open-source mode.
- OpenClaw file-based memory is disabled.
- Mid-term memory remains a custom episodic store in Postgres + pgvector.
- Mattermost work is split into Mattermost-side setup and OpenClaw-side implementation.

---

# Spec 1: Mattermost Integration and Command Routing

## 1. Purpose

This spec defines the Mattermost-facing behavior for session controls and memory controls in an OpenClaw deployment.

It does **not** define canonical session storage. OpenClaw Gateway owns sessions. Mattermost commands are an interface that target the currently active OpenClaw session and the external memory subsystems.

This spec is intentionally split into two parts:

- **Part A — Mattermost-side work:** slash command registration, bot plumbing, callback routing.
- **Part B — OpenClaw-side work:** command handlers, session finalization hooks, retrieval, and memory orchestration.

## 2. Architecture Decisions

### Source of Truth

- **Sessions:** OpenClaw Gateway
- **Long-term memory:** official Mem0 OpenClaw plugin + Qdrant
- **Mid-term memory:** custom episode store in Postgres + pgvector
- **Mattermost commands:** thin control surface over OpenClaw/plugin behavior

### Explicit Non-Goals

This system does **not**:

- maintain a parallel canonical `sessions` table
- use `MEMORY.md` or daily Markdown memory files
- introduce a user-facing `/prune` command

## 3. Session Model

A session is the active OpenClaw conversation state for a given user/channel/agent context as determined by the Gateway.

Mattermost must treat the OpenClaw session as canonical and only store **derived metadata** where necessary, such as:

- last finalized episode id
- last session-finalization timestamp
- command audit events
- pending confirmation state for destructive commands like `/forget --all`

## 4. User-Facing Commands

### Reuse Native OpenClaw Commands

These commands should remain OpenClaw-native:

- `/new`
- `/reset`
- `/compact`

### Add Custom Commands

These commands should be implemented as OpenClaw plugin auto-reply commands:

- `/recall`
- `/forget`
- `/memory`
- optional `/clear`

### Command Semantics

#### `/clear`

Purpose: finalize the current session, persist external memories, and leave no active working session until the next user message.

Behavior:

1. Resolve the current OpenClaw session.
2. If none exists, reply: `No active session to clear.`
3. Finalize the session:
   - generate/store episode record
   - allow Mem0 long-term extraction for final exchange if needed
   - mark any command-level pending state as closed

4. Clear working context using the OpenClaw session-reset path.
5. Reply:
   - `✓ Session finalized. Mid-term episode stored. Next message starts fresh.`

Flags:

- `--discard`: do not create an episode and do not write explicit memory artifacts for this session
- `--quiet`: suppress normal confirmation message

#### `/recall [query]`

Purpose: explicitly inspect memory.

Default behavior:

- search long-term memory via Mem0 tools
- search episode store via episode retrieval service
- display grouped results

Flags:

- `--long-term`
- `--sessions`
- `--all`

Result format:

- group by Long-Term Facts and Past Sessions
- include identifiers for deletion where applicable
- paginate when needed

#### `/forget [query|id]`

Purpose: remove incorrect or sensitive memory.

Behavior:

1. Resolve matches in the selected scope(s).
2. Present candidate results.
3. Require confirmation for destructive deletion.
4. Delete from the appropriate backend:
   - Mem0 for long-term facts
   - Postgres episode store for episodes

5. Write audit log entry.

Flags:

- `--all` deletes all long-term memories for this user and all their episodes; requires double confirmation
- `--long-term`
- `--sessions`

#### `/memory`

Purpose: show a memory dashboard.

Shows:

- whether an active OpenClaw session exists
- recent episode count
- long-term memory count
- last episode timestamp
- top categories if available
- health/degraded status of Mem0/Qdrant and episode DB

## 5. Retrieval Policy

On each normal user message:

1. OpenClaw loads the active session.
2. Mem0 plugin auto-recall injects relevant long-term memories.
3. Custom episode retriever fetches:
   - the most recent relevant episode
   - up to N semantically relevant episodes

4. Episode context is injected as a compact structured block.
5. OpenClaw builds the final prompt and continues normally.

## 6. Scope Rules

### v1 Defaults

- **Long-term memory scope:** per user
- **Episode scope:** per user, optionally filtered by channel
- **Shared channel memory:** disabled in v1
- **Cross-agent sharing:** disabled in v1 unless explicitly enabled later

### Rationale

This avoids accidental leakage in shared Mattermost channels and keeps behavior predictable.

## 7. Part A — Mattermost-Side Work

This section covers what must be configured in Mattermost or in the Mattermost channel integration layer.

### 7.1 Bot / App Setup

Mattermost must have:

- a bot or integration user connected to OpenClaw
- permission to register slash commands if using native commands
- a reachable callback URL to the OpenClaw Gateway

### 7.2 Native Command Registration Strategy

Two supported modes:

#### Mode 1 — Use OpenClaw native Mattermost commands where possible

Enable OpenClaw native Mattermost commands for built-ins and optionally plugin commands.

Use this for:

- `/new`
- `/reset`
- built-in `oc_*` commands
- potentially custom plugin commands if exposed via native command plumbing

#### Mode 2 — Register Mattermost-native commands that call OpenClaw endpoints

Use Mattermost slash commands that POST to OpenClaw HTTP endpoints or command callbacks.

Use this when:

- you want custom UX or naming
- you want stricter routing than plain text chat commands
- you want command execution outside the AI loop

### 7.3 Recommended v1 Split

Mattermost-side commands:

- `/recall`
- `/forget`
- `/memory`
- optional `/clear`

Native OpenClaw / text commands retained:

- `/new`
- `/reset`
- `/compact`

### 7.4 Callback Contract

Mattermost command payload should include at minimum:

- mattermost user id
- channel id
- team id
- command name
- raw text args
- request id / trace id

OpenClaw must map this payload to:

- stable `userId` for Mem0
- active Gateway session lookup key
- agent identity if needed

## 8. Part B — OpenClaw-Side Work

This section covers the code and plugin work inside OpenClaw.

### 8.1 Plugin Responsibilities

Create one custom plugin responsible for:

- registering `/recall`, `/forget`, `/memory`, optional `/clear`
- exposing any needed HTTP routes for Mattermost callbacks
- querying the episode store
- formatting episode context
- coordinating with the Mem0 plugin tools or APIs
- running finalization hooks on `/new` and `/clear`

### 8.2 Hooks

Register plugin hooks for:

- `command:new` to finalize the previous session episode before reset
- prompt-build hook to prepend episode context
- optional background cleanup for episode retention

### 8.3 Context Injection

Use a prompt hook to inject:

- recent/semantic episode summaries
- pending tasks from the latest episode

Do not re-implement long-term recall inside this plugin if Mem0 auto-recall already covers it.

### 8.4 Failure Modes

If episode retrieval fails:

- continue without episode context
- log warning
- surface a lightweight status note only for explicit commands

If Mem0/Qdrant fails:

- plugin commands using long-term memory should degrade cleanly
- regular chat still works

## 9. Configuration

```yaml
mattermost_integration:
  commands:
    custom:
      enabled: true
      names: [recall, forget, memory, clear]
    native_reuse:
      enabled: true
      names: [new, reset, compact]

  scope:
    long_term: user
    episodes: user
    channel_filter_for_recent: true
    shared_channel_memory: false
    cross_agent_sharing: false

  session:
    idle_timeout_minutes: 30
    finalize_on_new: true
    finalize_on_clear: true

  retrieval:
    max_episode_results: 3
    max_episode_tokens: 2000
```

## 10. Open Questions

1. Should `/clear` remain a separate command, or should `/reset` semantics be extended and documented for users?
2. Should custom commands be fully Mattermost-native or routed as text/native OpenClaw commands?
3. Should v2 add a project-shared memory namespace distinct from user memory?

---

# Spec 2: Mid-Term Memory (Episode Store)

## 1. Purpose

Mid-term memory stores structured episode records derived from finalized OpenClaw sessions.

This is the narrative layer: what happened, what was decided, what remains pending.

It complements long-term memory:

- **episodes** = narrative, temporal, session-shaped
- **long-term memories** = durable atomic facts

## 2. Source of Truth

OpenClaw sessions are canonical.

The episode store is **derived**. It never replaces Gateway session state and must not be used to infer the currently active session independently of OpenClaw.

## 3. Data Model

### Episode Record

```python
@dataclass
class Episode:
    episode_id: str
    source_session_id: str         # OpenClaw sessionId
    source_session_key: str | None # Optional OpenClaw sessionKey for diagnostics

    user_id: str
    agent_id: str
    channel_id: str | None

    summary: str
    key_decisions: list[str]
    files_touched: list[str]
    tasks_completed: list[str]
    tasks_pending: list[str]
    errors_encountered: list[str]

    started_at: datetime | None
    ended_at: datetime
    session_duration_minutes: int | None
    message_count: int | None
    total_tokens_used: int | None

    summary_embedding: list[float]
    created_at: datetime
```

## 4. Storage

Use Postgres + pgvector.

### Required Design Rules

- embedding dimension must match the chosen model exactly
- v1 standardizes on `all-MiniLM-L6-v2` with dimension **384**
- `source_session_id` must be treated as idempotency key candidate
- no foreign key to a custom `sessions` table

### Schema

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE episodes (
    episode_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_session_id     TEXT NOT NULL UNIQUE,
    source_session_key    TEXT,

    user_id               TEXT NOT NULL,
    agent_id              TEXT NOT NULL,
    channel_id            TEXT,

    summary               TEXT NOT NULL,
    key_decisions         JSONB NOT NULL DEFAULT '[]',
    files_touched         JSONB NOT NULL DEFAULT '[]',
    tasks_completed       JSONB NOT NULL DEFAULT '[]',
    tasks_pending         JSONB NOT NULL DEFAULT '[]',
    errors_encountered    JSONB NOT NULL DEFAULT '[]',

    started_at            TIMESTAMPTZ,
    ended_at              TIMESTAMPTZ NOT NULL,
    session_duration_m    INT,
    message_count         INT,
    total_tokens_used     INT,

    summary_embedding     vector(384) NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_episodes_user_created
  ON episodes(user_id, created_at DESC);

CREATE INDEX idx_episodes_user_channel_created
  ON episodes(user_id, channel_id, created_at DESC);

CREATE INDEX idx_episodes_embedding
  ON episodes USING ivfflat (summary_embedding vector_cosine_ops)
  WITH (lists = 100);
```

## 5. Episode Generation

### Trigger Points

Episodes are generated when an OpenClaw session is finalized via:

- `/new`
- `/clear`
- idle timeout
- explicit administrative finalization hook

### Pipeline

1. Read finalized session transcript from OpenClaw/Gateway-facing APIs or available session data.
2. Build structured summary with an LLM.
3. Generate summary embedding.
4. Upsert episode by `source_session_id`.
5. Store structured fields.
6. Make pending tasks available for next-session continuity.

### Important Rule

Long-term extraction must not depend on episode creation succeeding.

If episode creation fails, long-term memory can still succeed.
If long-term memory fails, episode creation can still succeed.
Each must be idempotent and independently logged.

## 6. Episode Extraction Prompt

```text
You are summarizing a completed work session between a user and an AI assistant.

Return JSON with:
- summary
- key_decisions
- files_touched
- tasks_completed
- tasks_pending
- errors_encountered

Rules:
- summary must be understandable without the original transcript
- include why major decisions were made
- keep file paths exact where known
- tasks_pending should capture unfinished work that matters in the next session
- omit temporary details that do not matter beyond this session
```

## 7. Retrieval

### Retrieval Modes

#### A. Continuation Retrieval

Used at the start of a new or resumed session.

Rules:

- include the most recent episode for this user
- if channel is known, prefer the most recent episode from the same channel
- include pending tasks prominently

#### B. Semantic Retrieval

Used during prompt construction.

Rules:

- search by summary embedding
- filter by `user_id`
- optionally bias toward same `channel_id`
- default max age: 30 days
- default max results: 3

### Safe Querying Rules

- no SQL string interpolation for age filters or channel filters
- all dynamic values must be parameterized

### Example Retrieval Shape

```python
async def retrieve_relevant_episodes(
    query_embedding,
    user_id: str,
    channel_id: str | None,
    max_results: int,
    max_age_days: int,
    similarity_threshold: float,
):
    ...
```

## 8. Prompt Injection Format

Episode context should be concise and structured.

Example:

```text
## Relevant Past Sessions
- 2 hours ago: Implemented Mattermost command routing and left memory search wiring unfinished.
  Pending: connect /recall to episode search; add deletion confirmation flow.
- 3 days ago: Chose Mem0 + Qdrant for long-term memory and decided to disable file-based memory.
```

## 9. Retention

### v1 Policy

- keep all episodes for 30 days
- delete after 90 days by default
- make retention configurable

### Precondition for Deletion

Episode deletion is allowed only after its source session has had a chance to flow through long-term extraction or explicit discard logic.

## 10. Cross-Scope Rules

### v1 Defaults

- episodes are user-scoped
- same-channel episodes may be preferred for ranking
- no shared channel-wide episode pool in v1
- no cross-agent retrieval in v1

## 11. Operations

### Re-Embedding

If embedding model changes, all episode summaries must be re-embedded and the pgvector schema must remain consistent with the new dimension.

### Observability

Log:

- episode generation success/failure
- source session id
- extraction latency
- embedding latency
- row upsert result

## 12. Configuration

```yaml
mid_term_memory:
  storage:
    type: postgres
    connection: ${DATABASE_URL}

  embedding:
    provider: local
    model: all-MiniLM-L6-v2
    dimension: 384

  extraction:
    model: claude-sonnet
    max_summary_tokens: 500

  retrieval:
    max_results: 3
    max_tokens: 2000
    similarity_threshold: 0.30
    max_age_days: 30
    prefer_same_channel: true

  retention:
    enabled: true
    cleanup_interval_hours: 24
    max_age_days: 90
```

## 13. Open Questions

1. Do we want parent/child linking between consecutive episodes in v2?
2. Should very short sessions be skipped below a message-count threshold?
3. Should there be an optional project-scoped episode namespace later?

---

# Spec 3: Long-Term Memory (Official Mem0 Plugin + Qdrant)

## 1. Purpose

Long-term memory stores durable facts that remain useful across sessions.

In v1 this is implemented by the official OpenClaw Mem0 plugin running in open-source mode, backed by Qdrant.

This spec intentionally does **not** describe a bespoke Mem0 integration from scratch. The official plugin is the baseline.

## 2. Source of Truth

- **Canonical long-term memory behavior:** `@mem0/openclaw-mem0`
- **Vector backend:** Qdrant
- **File-based OpenClaw memory:** disabled

## 3. OpenClaw Alignment

Set OpenClaw memory plugin slot to `none` so file-based `MEMORY.md`/daily logs are not part of the active architecture.

### Required Setting

```json
{
  "plugins": {
    "slots": {
      "memory": "none"
    }
  }
}
```

## 4. Plugin Setup

### Install

```bash
openclaw plugins install @mem0/openclaw-mem0
```

### Configure (Open-Source Mode)

```json
{
  "plugins": {
    "entries": {
      "openclaw-mem0": {
        "enabled": true,
        "config": {
          "mode": "open-source",
          "userId": "${DYNAMIC_USER_ID}",
          "oss": {
            "vectorStore": {
              "provider": "qdrant",
              "config": {
                "host": "localhost",
                "port": 6333,
                "collectionName": "openclaw_memories"
              }
            },
            "embedder": {
              "provider": "openai",
              "config": {
                "model": "text-embedding-3-small"
              }
            },
            "llm": {
              "provider": "openai",
              "config": {
                "model": "gpt-4o"
              }
            }
          }
        }
      }
    }
  }
}
```

Note: if you choose local embeddings/LLM later, keep dimension compatibility aligned with any custom stores that share embeddings.

## 5. Scoping Rules

### Required v1 Rule

`userId` must be mapped dynamically from the authenticated Mattermost/OpenClaw user.

Never hardcode a shared value.

### Scope Types

- **User scope** = durable long-term memory across sessions
- **Session scope** = plugin-managed short-term/session memory via Mem0 `runId`

### v1 Policy

- enable per-user long-term memory
- allow plugin session memory to operate normally
- do not create a shared channel long-term namespace in v1

## 6. What the Plugin Provides

The plugin provides:

- auto-recall before agent response
- auto-capture after agent response
- tools for explicit memory operations

This means the agent can both automatically benefit from memory and handle explicit memory commands through tools or plugin command wrappers.

## 7. Memory Tools

Available tools:

- `memory_search`
- `memory_list`
- `memory_store`
- `memory_get`
- `memory_forget`

### Command Mapping

Recommended mapping for your custom UX:

- `/recall` → `memory_search` and/or `memory_list`
- `/forget` → `memory_forget`
- `/memory` → counts + categories + health, optionally backed by `memory_list`
- explicit “remember X” flows → `memory_store`

## 8. What Gets Stored

Long-term memory should capture durable facts such as:

- project architecture
- stable code conventions
- user preferences
- team/org information
- decisions that remain relevant across sessions
- environment and setup details

It should avoid:

- transient debugging state
- temporary blockers
- superseded ephemeral details
- secrets or sensitive tokens

## 9. Security

### Never Store

Reject or sanitize:

- passwords
- API keys
- bearer tokens
- private secrets
- highly sensitive identifiers unless explicitly approved

### Isolation

- all long-term memories are scoped by `userId`
- administrative deletion paths must be auditable
- `/forget --all` must require confirmation

## 10. Retrieval Policy

Long-term recall for normal chat is handled primarily by the Mem0 plugin’s auto-recall.

Do not duplicate long-term retrieval in the custom episode plugin unless there is a proven gap.

### Explicit Retrieval

For `/recall` and `/memory`, the custom command layer may call Mem0 tools or a thin wrapper around them to present structured results.

## 11. Interaction with Episode Store

Episodes and long-term facts are complementary.

- Episodes answer: what happened and what remains pending?
- Long-term memories answer: what remains true across sessions?

Neither should try to replace the other.

## 12. Performance

### v1 Guidance

- start with the official plugin defaults or a minimal open-source configuration
- benchmark before introducing custom graph memory or custom extraction sidecars
- keep the architecture plugin-first, not fork-first

## 13. Optional v2 Enhancements

- metadata categorization for memory dashboard
- project-scoped shared memory
- graph memory
- confidence scoring / reinforcement

## 14. Configuration

```yaml
long_term_memory:
  provider: mem0_openclaw_plugin
  mode: open_source

  user_scope:
    source: mattermost_authenticated_user
    required: true

  qdrant:
    host: localhost
    port: 6333
    collection: openclaw_memories

  retrieval:
    normal_chat: auto_recall
    explicit_commands: true

  security:
    sanitize_secrets: true
    audit_logging: true

openclaw:
  plugins:
    slots:
      memory: none
```

## 15. Open Questions

1. Do we want local embeddings/LLM for Mem0 open-source mode, or keep defaults initially?
2. Should we add category metadata only after observing real query needs?
3. Should explicit `remember ...` UX be done via natural language, slash commands, or both?

---

# Implementation Summary

## Keep Native

- OpenClaw session ownership
- `/new`
- `/reset`
- `/compact`

## Build Custom

- episode store
- episode retrieval/injection plugin
- `/recall`
- `/forget`
- `/memory`
- optional `/clear`

## Disable

- file-based OpenClaw memory (`MEMORY.md`, daily memory files, file-memory plugin)

## Mattermost Split

- Mattermost-side: slash command registration, callback delivery, bot setup
- OpenClaw-side: plugin commands, hooks, retrieval orchestration, Mem0 + episode coordination
