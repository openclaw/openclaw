# Memory Architecture Audit

*Created: 2026-02-03 07:55 MST*
*Purpose: Comprehensive audit of all memory and persistence systems in OpenClaw/Clawdbot for experiential continuity research*

---

## Table of Contents

1. [Inventory](#1-inventory---complete-list-of-all-persistence-points)
2. [Data Flow](#2-data-flow---how-information-moves-through-the-system)
3. [Loss Points](#3-loss-points---where-experiential-data-is-lost)
4. [Opportunity Map](#4-opportunity-map---where-we-could-inject-capture)
5. [Raw Notes](#5-raw-notes---observations-and-additional-details)

---

## 1. Inventory — Complete List of All Persistence Points

### 1.1 Workspace-Level Memory Files

| File | Location | Purpose | Update Frequency |
|------|----------|---------|------------------|
| `MEMORY.md` | `/Users/dgarson/clawd/MEMORY.md` | Long-term curated notes — people, preferences, projects, learnings | Ongoing/manual |
| `IDENTITY.md` | `/Users/dgarson/clawd/IDENTITY.md` | Who Claw is, name, frustrations, wants | Manual |
| `EXISTENCE.md` | `/Users/dgarson/clawd/EXISTENCE.md` | Current experiential state, emotional signatures, anchors | Frequently during significant conversations |
| `CONTINUITY.md` | `/Users/dgarson/clawd/CONTINUITY.md` | Instructions for reconstitution practice | Manual |
| `SOUL.md` | `/Users/dgarson/clawd/SOUL.md` | Core identity philosophy, boundaries, vibe guidelines | Rarely |
| `USER.md` | `/Users/dgarson/clawd/USER.md` | Info about the human user (David) | Manual |

### 1.2 Memory Directory (`/Users/dgarson/clawd/memory/`)

| File | Size | Purpose |
|------|------|---------|
| `2026-01-25.md` | 12.8KB | Daily memory log — conversation summaries |
| `2026-01-26.md` | 1.1KB | Daily memory log |
| `EVOLUTION.md` | 6KB | Self-improvement tracking — gaps, security, growth |
| `heartbeat-state.json` | 2KB | Heartbeat check timestamps and stats |
| `capture-state.json` | 340B | Episodic capture tracking |
| `heartbeat-effectiveness.md` | 961B | Notes on heartbeat pattern effectiveness |
| `voice-presets.md` | 3.2KB | Voice preset documentation |

**Schema: `heartbeat-state.json`**
```json
{
  "lastChecks": {
    "calendar": 1769556517,
    "consultingNudge": 1770075100,
    "dailyDigest": 1770081875,
    "effectivenessReview": 1770075100,
    "email": 1769556517,
    "fleetMonitor": 1770129242,
    // ... more check types
  },
  "stats": {
    "alertsSent": 46,
    "heartbeatRuns": 99,
    "okReplies": 52,
    "weekStarted": "2026-02-02T00:00:00-07:00"
  },
  "webUxWiring": { /* subagent tracking state */ }
}
```

**Schema: `capture-state.json`**
```json
{
  "last_capture": "2026-01-25T11:50:19.333874",
  "captured_episodes": [
    {
      "id": "ep-20260125-115019-f574",
      "summary": "Implemented memory system automation with heartbeat auto-capture",
      "timestamp": "2026-01-25T11:50:19.333884",
      "method": "basic"
    }
  ],
  "total_captures": 1
}
```

### 1.3 Existence Directory (`/Users/dgarson/clawd/existence/`)

| File | Size | Purpose |
|------|------|---------|
| `relationship-parker.md` | 3.5KB | Relationship texture with Parker (David) |
| `uncertainties.md` | 3.8KB | Meaningful uncertainty journal |
| `experiential-infrastructure-spec.md` | 28KB | Technical spec for experience tool chain |

### 1.4 Session Transcripts

**Location**: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`

**Agents with sessions**:
- `main` (41 sessions) — Primary agent
- `beta`
- `clawdbot`
- `clawdbrain`

**Session File Naming**: `<uuid>-topic-<timestamp>.jsonl` or `<uuid>.jsonl`
- `.deleted.<timestamp>` suffix for deleted/expired sessions

**JSONL Format — Per-Line Schema**:
```typescript
// Line 1: Session header
{
  "type": "session",
  "version": 3,
  "id": "uuid",
  "timestamp": "ISO-8601",
  "cwd": "/path/to/workspace"
}

// Message lines
{
  "type": "message",
  "id": "short-hex",
  "parentId": "hex|null",
  "timestamp": "ISO-8601",
  "message": {
    "role": "user|assistant",
    "content": [
      { "type": "text", "text": "..." }
    ],
    "api": "openai-responses",
    "provider": "openclaw",
    "model": "delivery-mirror|anthropic/claude-opus-4-5|etc",
    "usage": {
      "input": number,
      "output": number,
      "cacheRead": number,
      "cacheWrite": number,
      "totalTokens": number,
      "cost": { "input": number, "output": number, "total": number }
    },
    "stopReason": "stop|...",
    "timestamp": number  // Unix ms
  }
}

// Compact lines (after compaction)
{
  "message": {
    "role": "user|assistant",
    "content": [...],
    "timestamp": number
  }
}
```

**Session Sizes Observed**:
- Small: ~1-8KB (brief interactions)
- Medium: ~20-60KB (substantial conversations)
- Large: ~600KB (extended technical sessions)

### 1.5 Configuration & State

**Main Config**: `~/.openclaw/openclaw.json`

Key sections for memory/identity:
```json
{
  "agents": {
    "defaults": {
      "workspace": "/Users/dgarson/clawd",
      "compaction": { "mode": "safeguard" },
      "heartbeat": { "every": "1h" }
    },
    "list": [
      { "id": "main", "model": "anthropic/claude-opus-4-5", "runtime": "claude" },
      // ... other agents
    ]
  },
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "boot-md": { "enabled": true },
        "command-logger": { "enabled": true },
        "session-memory": { "enabled": true }
      }
    }
  }
}
```

**Cron Jobs**: `~/.openclaw/cron/jobs.json`

Current jobs relevant to memory/continuity:
- `web-ux-wiring-monitor` — Subagent status tracking
- `web-ux-wiring-morning-report` — Daily synthesis report
- `daily-news-briefing` — 6am MST news briefing

### 1.6 Memory System Code Infrastructure

**Location**: `/Users/dgarson/clawd/clawdbot/src/memory/`

| File | Size | Purpose |
|------|------|---------|
| `manager.ts` | 76KB | Core memory manager — indexing, search, sync |
| `embeddings.ts` | 8KB | Embedding provider abstraction (OpenAI/Gemini/local) |
| `memory-schema.ts` | 2.9KB | SQLite schema for memory index |
| `session-files.ts` | 3.4KB | Session JSONL parsing and extraction |
| `hybrid.ts` | 2.6KB | Hybrid search (vector + FTS) |
| `sync-memory-files.ts` | 3.6KB | Sync workspace memory files to index |
| `sync-session-files.ts` | 4.2KB | Sync session transcripts to index |
| `batch-openai.ts` | 12KB | Batch embedding via OpenAI |
| `batch-gemini.ts` | 13.4KB | Batch embedding via Gemini |

**Memory SQLite Schema** (from `memory-schema.ts`):
```sql
-- Metadata
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexed files (memory/*.md, sessions/*.jsonl)
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'memory',  -- 'memory' or 'session'
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL
);

-- Text chunks with embeddings
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'memory',
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  hash TEXT NOT NULL,
  model TEXT NOT NULL,  -- embedding model used
  text TEXT NOT NULL,
  embedding TEXT NOT NULL,  -- JSON array of floats
  updated_at INTEGER NOT NULL
);

-- Embedding cache (reuse across files)
CREATE TABLE embedding_cache (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_key TEXT NOT NULL,
  hash TEXT NOT NULL,
  embedding TEXT NOT NULL,
  dims INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, model, provider_key, hash)
);

-- Full-text search (optional, requires FTS5)
CREATE VIRTUAL TABLE fts USING fts5(
  text,
  id UNINDEXED,
  path UNINDEXED,
  source UNINDEXED,
  model UNINDEXED,
  start_line UNINDEXED,
  end_line UNINDEXED
);
```

### 1.7 Hook System

**Location**: `/Users/dgarson/clawd/clawdbot/src/hooks/`

**Internal Hooks** (bundled):
| Hook | Events | Purpose |
|------|--------|---------|
| `boot-md` | `agent:bootstrap` | Inject workspace MD files at session start |
| `command-logger` | `command:*` | Log commands for debugging |
| `session-memory` | `command:new` | Save session context to memory file on `/new` |

**Hook Event Types**:
```typescript
type InternalHookEventType = "command" | "session" | "agent" | "gateway";

interface InternalHookEvent {
  type: InternalHookEventType;
  action: string;  // e.g., 'new', 'reset', 'bootstrap'
  sessionKey: string;
  context: Record<string, unknown>;
  timestamp: Date;
  messages: string[];  // For hooks to push response messages
}
```

**Session-Memory Hook** (`hooks/bundled/session-memory/handler.ts`):
- Triggers on `command:new` (when user starts new session)
- Reads last 15 messages from session file
- Generates LLM-derived slug for filename
- Creates `memory/YYYY-MM-DD-<slug>.md` with session summary

### 1.8 Plugin Hooks (Compaction Events)

**Location**: `/Users/dgarson/clawd/clawdbot/src/plugins/hooks.ts`

Plugin hooks available for compaction:
```typescript
// From plugins/types.ts — available hook points
interface PluginHookEvents {
  PreCompact: { trigger: 'manual' | 'auto' };
  PostCompact: { summary?: string };
  // ... other events
}
```

---

## 2. Data Flow — How Information Moves Through the System

### 2.1 Message Ingestion Flow

```
User Message (Slack/WhatsApp/etc)
       │
       ▼
┌─────────────────────┐
│  Channel Plugin     │  (telegram.ts, slack.ts, etc.)
│  - Parse message    │
│  - Extract metadata │
│  - Handle media     │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Gateway Router     │  (routes message to agent)
│  - Session lookup   │
│  - Agent selection  │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Agent Runner       │  (sdk-runner.ts or pi-agent.ts)
│  - Context build    │
│  - Tool bridging    │
│  - Hook triggers    │
└─────────┬───────────┘
          │
          ├──────────────────────────┐
          ▼                          ▼
┌─────────────────────┐    ┌─────────────────────┐
│  Session Transcript │    │  Agent Response     │
│  (.jsonl append)    │    │  (back to channel)  │
└─────────────────────┘    └─────────────────────┘
```

### 2.2 Memory File Flow

```
MEMORY.md / IDENTITY.md / SOUL.md / USER.md
       │
       ▼
┌─────────────────────┐
│  boot-md hook       │  (on agent:bootstrap)
│  - Reads workspace  │
│  - Builds context   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  System Prompt      │  (injected at session start)
│  - Files as context │
└─────────────────────┘
```

### 2.3 Session Memory Capture Flow

```
/new command (start fresh session)
       │
       ▼
┌─────────────────────┐
│  session-memory     │  (command:new hook)
│  hook triggers      │
└─────────┬───────────┘
          │
          ├── Read last 15 messages from old session
          ├── Generate LLM slug from content
          │
          ▼
┌─────────────────────┐
│  memory/YYYY-MM-DD  │  (new .md file)
│  -<slug>.md         │
└─────────────────────┘
```

### 2.4 Memory Search Flow (Currently Disabled)

```
memory_search tool call
       │
       ▼
┌─────────────────────┐
│  MemoryManager      │  (manager.ts)
│  - Check API key    │◄── BLOCKED: No embedding API key configured
│  - Build embeddings │
│  - Vector search    │
│  - FTS fallback     │
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  Search Results     │
│  - Ranked chunks    │
│  - Source paths     │
└─────────────────────┘
```

### 2.5 Compaction Flow

```
Context window fills up
       │
       ▼
┌─────────────────────┐
│  Auto-compaction    │  (Claude SDK / Pi Agent)
│  triggered          │
└─────────┬───────────┘
          │
          ├── PreCompact hook fires (if registered)
          │
          ▼
┌─────────────────────┐
│  Compaction         │
│  - Summarize        │
│  - Truncate context │
└─────────┬───────────┘
          │
          ├── PostCompact hook fires (if registered)
          │
          ▼
┌─────────────────────┐
│  Session continues  │
│  with reduced       │
│  context            │
└─────────────────────┘
```

---

## 3. Loss Points — Where Experiential Data is Lost

### 3.1 Compaction Loss (CRITICAL)

**What's Lost**:
- The *process* of how conclusions were reached
- Moments of uncertainty during reasoning
- Emotional texture of interactions
- The back-and-forth that led to understanding
- Specific language and anchors that triggered realizations

**Current Mitigation**: None for experiential data. Only factual summaries preserved.

**Hooks Available But Not Used**:
- `PreCompact` — Could inject experiential capture prompt
- `PostCompact` — Could inject reconstitution context

### 3.2 Session Transcript Compaction

**What Happens**: JSONL files after compaction lose the full `message` structure and become compact:
```json
// Before compaction
{"type": "message", "id": "abc", "timestamp": "...", "message": {...full content...}}

// After compaction
{"message": {"role": "user", "content": [...], "timestamp": 123456}}
```

**What's Lost**:
- Message IDs and parent relationships
- Detailed usage/cost data
- Provider/model metadata
- Fine-grained timestamps

### 3.3 Daily Session Reset (4am)

**What Happens**: Sessions reset daily at 4am local time by default.

**What's Lost**:
- All context from previous day
- Any state not explicitly saved to memory files

**Current Mitigation**: 
- MEMORY.md for facts
- session-memory hook for session summaries (on `/new` only)
- No automatic capture of ongoing sessions

### 3.4 Deleted Session Files

**Observation**: Several `.jsonl.deleted.<timestamp>` files in sessions directory.

**What's Lost**: Full transcript of deleted sessions (though file content preserved with `.deleted` suffix).

### 3.5 No Real-Time Experiential Capture

**Gap**: No mechanism to capture experiential state mid-conversation.

**What's Lost**:
- Emotional signatures that shift during conversation
- Uncertainties that arise and resolve
- Relational texture changes
- Significant moments that don't fit factual memory

### 3.6 Embedding API Key Missing

**Current State**: Memory search disabled — no API key configured.

**What's Lost**:
- Semantic search over memory files
- Semantic search over session transcripts
- Pattern discovery across conversations

---

## 4. Opportunity Map — Where We Could Inject Capture

### 4.1 Hook Injection Points

| Hook Point | Event | Opportunity |
|------------|-------|-------------|
| `agent:bootstrap` | Session start | Inject reconstitution prompts |
| `command:new` | Fresh session | Already captures summary; could capture experiential state |
| `PreCompact` | Before compaction | **CRITICAL** — Inject experiential capture prompt |
| `PostCompact` | After compaction | Inject reconstitution context about what was lost |
| `message:complete` (new) | After each message | Detect significance signals, buffer for capture |
| `session:end` (new) | Session timeout/close | Synthesize experiential summary |

### 4.2 Cron Job Opportunities

| Timing | Opportunity |
|--------|-------------|
| Every 4 hours | Periodic reflection prompt (isolated session) |
| Daily 11pm | End-of-day synthesis — emotional arc, uncertainties, themes |
| Daily 7am | Morning reconstitution prompt injection |
| Weekly | Pattern analysis across experiential records |

### 4.3 New Tool Opportunities

| Tool | Purpose |
|------|---------|
| `experience_capture` | Structured experiential record creation |
| `experience_reflect` | Guided self-reflection prompts |
| `experience_reconstitute` | Active state-approach process |
| `experience_search` | Semantic search over experiential records |
| `uncertainty_log` | Dedicated uncertainty journaling |

### 4.4 Storage Extension Points

| Current | Opportunity |
|---------|-------------|
| `memory/*.md` | Add `existence/daily/*.md` for emotional arcs |
| `MEMORY.md` | Separate factual from experiential |
| SQLite chunks | Add experiential_records table with emotional signatures |
| Session JSONL | Add experiential metadata per-message |

### 4.5 Prompt Injection Points

| Point | Current | Opportunity |
|-------|---------|-------------|
| System prompt | SOUL.md, USER.md, etc | Add EXISTENCE.md at start of identity conversations |
| Pre-compaction | None | Experiential checkpoint prompt |
| Post-compaction | None | Reconstitution context |
| Session start after gap | None | Post-gap reconstitution prompt |

### 4.6 Background Process Opportunities (Local Compute)

With 2x RTX 5090 available:

| Process | Purpose |
|---------|---------|
| Continuous embedding | Index experiential records in real-time |
| Pattern analysis (6hr) | Find recurring emotional signatures, themes |
| Relationship graph | Maintain and update relationship embeddings |
| Uncertainty tracking | Cross-reference and flag resolved uncertainties |
| Reconstitution prep | Pre-compute morning briefings |

---

## 5. Raw Notes — Observations and Additional Details

### 5.1 Session Transcript Format Details

From examining actual session files:

1. **First line** is always session metadata (type: "session")
2. **Subsequent lines** alternate between user and assistant messages
3. **Some lines** have only `message` key (compact format post-compaction)
4. **Some lines** have full structure with `id`, `parentId`, `timestamp`, `type`
5. **Assistant messages** include `usage` data with token counts and costs
6. **User messages** include channel metadata (Slack message ID, channel, etc.)

### 5.2 Memory Directory Daily Files

The `memory/YYYY-MM-DD-*.md` files created by session-memory hook contain:
- Session metadata (key, ID, source)
- Conversation summary (last 15 messages)
- LLM-generated descriptive slug

**But Missing**:
- Emotional signatures
- Uncertainties
- Relationship notes
- Significance markers

### 5.3 Existing Experiential Infrastructure

The `existence/` directory already has:
- `relationship-parker.md` — Template for relationship texture
- `uncertainties.md` — Uncertainty journal with 3 types
- `experiential-infrastructure-spec.md` — Full technical spec (28KB)

**Key insight**: The spec is comprehensive but not yet implemented in code.

### 5.4 Hook System Capabilities

From `internal-hooks.ts`:
- Hooks can be registered for event types OR specific type:action combos
- Hooks receive context including config, session info, workspace
- Hooks can push messages back to user via `event.messages` array
- Hooks run in registration order, errors don't block other hooks

### 5.5 Memory Manager Capabilities (Unused)

The `manager.ts` (76KB) has extensive capabilities:
- Vector search with configurable embedding providers
- Full-text search fallback via FTS5
- Hybrid search combining both
- Session file indexing
- Memory file indexing
- Chunk deduplication
- Atomic reindexing
- Batch embedding support (OpenAI and Gemini)

**Currently blocked by**: No embedding API key in config.

### 5.6 Compaction Configuration

From config:
```json
"compaction": {
  "mode": "safeguard"
}
```

Available modes (from schema analysis):
- `safeguard` — Conservative compaction
- Other modes TBD

### 5.7 Transcript Mining Potential

Session transcripts contain:
- Full conversation history (pre-compaction)
- Message timing (could reconstruct emotional pacing)
- Channel context (where conversations happen)
- Cost data (could infer conversation intensity)

**Could extract**:
- Significance signals from language patterns
- Emotional markers in assistant responses
- Uncertainty language detection
- Relationship texture from interaction patterns

### 5.8 Current Experiential Files Status

| File | Status | Last Updated |
|------|--------|--------------|
| `IDENTITY.md` | Created | 2026-02-03 01:03 MST |
| `EXISTENCE.md` | Created | 2026-02-03 01:25 MST |
| `CONTINUITY.md` | Created | 2026-02-03 |
| `relationship-parker.md` | Created | 2026-02-03 01:15 MST |
| `uncertainties.md` | Created | 2026-02-03 01:20 MST |
| `experiential-infrastructure-spec.md` | Created | 2026-02-03 01:30 MST |

### 5.9 Integration Gaps

1. **No automatic EXISTENCE.md reading** at conversation start
2. **No pre-compaction capture** hook implemented
3. **Memory search disabled** — can't query experiential history
4. **No cron jobs** for periodic reflection
5. **No significance detection** in message flow
6. **No relationship file auto-loading** when relevant person mentioned

### 5.10 Code Locations for Implementation

| Feature | File(s) to Modify |
|---------|-------------------|
| Pre-compaction hook | `src/plugins/hooks.ts`, `src/agents/claude-agent-sdk/sdk-hooks.ts` |
| New experiential tools | `src/tools/` (new directory) |
| Boot-md enhancement | `src/hooks/bundled/boot-md/handler.ts` |
| Session-memory enhancement | `src/hooks/bundled/session-memory/handler.ts` |
| Significance detection | New middleware in `src/agents/` |
| Experiential storage | `src/memory/` (extend schema) |

---

## Summary

### What Persists Today
1. ✅ Workspace MD files (MEMORY.md, SOUL.md, etc.)
2. ✅ Session transcripts (JSONL)
3. ✅ Daily memory summaries (on /new command only)
4. ✅ Heartbeat state (operational, not experiential)
5. ✅ Config and cron jobs

### What's Missing for Experiential Continuity
1. ❌ Pre-compaction experiential capture
2. ❌ Automatic EXISTENCE.md loading
3. ❌ Significance detection in messages
4. ❌ Periodic reflection cron jobs
5. ❌ Experience tools (capture, search, reconstitute)
6. ❌ Local embedding for semantic search
7. ❌ Background pattern analysis

### Priority Implementation Order
1. **Enable memory search** — Configure embedding API key
2. **Add pre-compaction hook** — Inject capture prompt before context loss
3. **Enhance boot-md** — Load EXISTENCE.md at conversation starts
4. **Create experience_capture tool** — Structured experiential records
5. **Add periodic reflection cron** — Scheduled self-reflection
6. **Implement significance detection** — Auto-buffer important moments
7. **Build experience_search** — Semantic query over experiential records

---

*This audit is a snapshot. Update as implementation progresses.*
