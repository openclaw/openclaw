# MEM-PERSIST-FOUNDATION-001 Audit Report

**Date:** 2026-06-22 15:30 KST
**Auditor:** 진희/OpenClaw
**Type:** Read-only audit (no DB writes, no code changes, no restarts)

---

## 1. Summary

Current JinheeOS has **two completely separate memory systems** with no bridge between them:

| System              | DB Path                                | Size     | Tables                                |
| ------------------- | -------------------------------------- | -------- | ------------------------------------- |
| **OpenClaw Memory** | `~/.openclaw/memory/main.sqlite`       | 21MB     | ~10 (chunks, embeddings, FTS, vector) |
| **JinheeOS Memory** | `/home/savit/ai/jinhee_data/jinhee.db` | **75MB** | **~250+** (7 memory subsystems)       |

The only connection between them is through workspace bootstrap files (`MEMORY.md`, `AGENTS.md`, `TOOLS.md`) which OpenClaw injects into the agent system prompt. JinheeOS's `nl_router.py` reads `canonical_memories` etc. from `jinhee.db` for its own context injection, but OpenClaw **never reads jinhee.db** and JinheeOS **never reads OpenClaw's main.sqlite**.

---

## 2. Memory Stores

### Store A: OpenClaw Memory (`~/.openclaw/memory/main.sqlite`)

- **21MB**, contains: `chunks` (with FTS5), `chunks_vec` (vector embeddings), `embedding_cache`, `files`, `meta`
- Used by: OpenClaw agent runtime (`memory_search` tool, memory-core plugin, memory-wiki plugin)
- Plugins enabled: `memory-core`, `memory-wiki` (listed in gateway startup: "11 plugins")
- Retrieval: via `memory_search` tool → vector similarity + FTS
- Write: via memory-core plugin (automatic session compaction/archival)

### Store B: JinheeOS Memory (`/home/savit/ai/jinhee_data/jinhee.db`)

- **75MB**, ~250+ tables across 7 memory subsystems:
  1. **Core Storage**: `memories` (214), `memory_items` (3), `canonical_memories` (20), `knowledge_chunks` (3), `conversation_logs` (1764)
  2. **Conflict Resolution**: 12 tables (`memory_conflicts`, `memory_conflict_evidence`, ...)
  3. **Quality Scoring**: 10+ tables (`memory_quality_scores`, `memory_quality_anomalies`, ...)
  4. **Lifecycle Management**: 8 tables (`memory_lifecycle_events`, `memory_lifecycle_tiers`, ...)
  5. **Retrieval Logging**: 10+ tables (`memory_retrieval_failures`, `runtime_memory_retrievals`, ...)
  6. **Import/Export**: 6 tables (`memory_import_entries`, `memory_import_sources`, ...)
  7. **Events/Versions**: 10+ tables (`memory_events`, `memory_versions`, `memory_version_chain`, ...)

### Store C: OpenClaw State (`~/.openclaw/state/openclaw.sqlite`)

- **21MB**, contains: `acp_sessions`, `agent_databases`, `gateway_restart_*`, session state
- Not directly a memory store, but contains session/agent state

### Store D: Workspace Bootstrap Files (`~/.openclaw/workspace/`)

- `MEMORY.md` — 14KB, injected into agent system prompt (priority 70)
- `AGENTS.md` — injected (guidance/soul)
- `TOOLS.md` — injected (usage guidance)
- `memory/YYYY-MM-DD.md` — daily raw logs (written by Jinhee tools, not read by OpenClaw)
- `CORE_MEMORY_SNAPSHOT.md` — recovery snapshot (manual use only)

---

## 3. DB Tables / Row Counts

Read-only query results from jinhee.db:

| Table                   | Row Count | Notes                             |
| ----------------------- | --------- | --------------------------------- |
| `memories`              | 214       | After earlier cleanup from ~44k   |
| `memory_items`          | 3         | Minimal                           |
| `conversation_logs`     | 1,764     | All Telegram conversation history |
| `canonical_memories`    | 20        | Verified facts                    |
| `knowledge_chunks`      | 3         | Minimal                           |
| `user_identity`         | 10        | User preferences                  |
| `personality_snapshots` | 0         | Empty                             |

---

## 4. Read Paths

### OpenClaw → Agent Context:

```
workspace.ts → bootstrap-files.ts → system-prompt.ts → agent
```

- MEMORY.md, AGENTS.md, TOOLS.md loaded as bootstrap files
- system-prompt.ts assigns priority: tools.md=50, bootstrap.md=60, memory.md=70
- MEMORY.md (14KB) under 20,000-char limit, so fully injected
- TOOLS.md (30KB) exceeds 12,000-char limit → **truncated** (confirmed from gateway log)

### OpenClaw → Memory Search (tool):

```
agent calls memory_search tool → tool-catalog.ts routes → memory-core plugin → main.sqlite
```

- Agent has `memory_search` tool available (in tool catalog)
- Uses vector embeddings for semantic search
- Separate from jinhee.db entirely

### JinheeOS → Memory Context:

```
nl_router.py → canonical_memories / memory_items / knowledge_chunks → context injection
```

- `nl_router.py` reads from jinhee.db directly
- `heartbeat_memory.py` reads conversation_logs for daily summaries
- `memory_retrieval.py`/`memory_service.py` in jinhee_os/app/services/ read from jinhee.db

### JinheeOS → OpenClaw:

No direct read path. The only overlap is through workspace files.

---

## 5. Write Paths

### OpenClaw Writes:

- `memory-core` plugin writes to `main.sqlite` (session compaction, archival)
- No direct SQL in TypeScript source found

### JinheeOS Writes:

| Script                      | Action                                       | Risk                              |
| --------------------------- | -------------------------------------------- | --------------------------------- |
| `jinhee_learning_engine.py` | `UPDATE memories`                            | Learning engine modifies memories |
| `lifecycle_migration.py`    | `UPDATE memories SET lifecycle_status = ...` | Manual migration                  |
| `truth_engine.py`           | `INSERT INTO canonical_memories`             | Validates/appends truths          |
| `evidence_importer.py`      | `INSERT INTO memories`                       | Imports external evidence         |
| `archive_recovery_v2.py`    | SELECT from `memories` (read-only)           | Safe                              |
| `distill_candidates.py`     | SELECT + promotion queue                     | Read-only until apply             |

---

## 6. Telegram/OpenClaw Prompt Injection

Confirmed path for Telegram messages:

1. Telegram message → `bot-message.ts` → `buildTelegramMessageContext()`
2. → `workspace.ts` loads bootstrap files (`MEMORY.md`, `AGENTS.md`, `TOOLS.md`)
3. → `system-prompt.ts` formats prompt with:
   - `MEMORY.md: durable user preferences and behavior guidance.`
   - `TOOLS.md is usage guidance, not availability.`
   - AGENTS.md/JinheeOS rules
4. → agent receives full system prompt + conversation history

**Key finding:** When `memory_search` plugin is available, the agent can call it for semantic search. But **no jinhee.db memory is automatically injected** into the agent prompt. Only the workspace bootstrap files (MEMORY.md, etc.) are injected.

The `_build_memory_context()` from the JinheeOS side (nl_router.py) is **not called** by OpenClaw — it was a JinheeOS-only function.

---

## 7. Workspace Memory Files

| File                              | Size   | Role                                        |
| --------------------------------- | ------ | ------------------------------------------- |
| `~/.openclaw/workspace/MEMORY.md` | 14KB   | Durable memory → agent prompt               |
| `~/.openclaw/workspace/AGENTS.md` | ~12KB  | Guidance → agent prompt                     |
| `~/.openclaw/workspace/TOOLS.md`  | 30KB   | Tools guide → **truncated** (exceeds limit) |
| `~/.openclaw/workspace/SOUL.md`   | ~5KB   | Persona → agent prompt                      |
| `~/.openclaw/workspace/USER.md`   | ~1KB   | User info → agent prompt                    |
| `memory/2026-06-22.md`            | varies | Daily raw notes                             |
| `CORE_MEMORY_SNAPSHOT.md`         | varies | Recovery snapshot                           |

**Note:** The actual workspace is `~/.openclaw/workspace/`, not the openclaw git repo root. But the openclaw repo's `src/agents/AGENTS.md` etc. are also loaded as templates.

---

## 8. Dangerous Operations / Risk Points

1. **`jinhee_learning_engine.py:33`** — `UPDATE memories` with learning engine
2. **`lifecycle_migration.py:10-21`** — Direct `UPDATE memories SET lifecycle_status` (6 migrations)
3. **`truth_engine.py:47`** — `INSERT INTO canonical_memories`
4. **`evidence_importer.py:18`** — `INSERT INTO memories`
5. **`jinhee.db` (75MB)** — No WAL-mode or backup strategy observed for concurrent access
6. **OpenClaw test files** — Some tests reference jinhee.db paths (risk of test → prod DB collision)
7. **`memories_archive` table** — Has data but no active archiving process observed

---

## 9. Confirmed Gaps

| Gap                                            | Severity  | Details                                                                  |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| **No bridge between OpenClaw↔JinheeOS memory** | 🔴 High   | OpenClaw uses main.sqlite, JinheeOS uses jinhee.db. No sync.             |
| **`nl_router.py` still active**                | 🟡 Medium | PID confirmed running. Reads canonical_memories for its own context.     |
| **TOOLS.md truncated**                         | 🟡 Medium | 30KB file, only ~12KB injected. Commands at end may be missing.          |
| **MEMORY.md manual-only**                      | 🟡 Medium | Must be manually curated. No auto-promotion from jinhee.db → MEMORY.md.  |
| **`_build_memory_context()` orphaned**         | 🔴 High   | Function exists in JinheeOS side but OpenClaw never calls it.            |
| **75MB jinhee.db → 214 memories only**         | 🟢 Low    | Most of the 75MB is indexes/embeddings/quality tables, not raw memories. |
| **`memory_promotion.py` queue present**        | 🟢 Low    | `promotion_queue` table exists but no active promotion to MEMORY.md.     |

---

## 10. Minimum Patch Candidates

> **Proposed only. Not implemented in this audit.**

### Candidate 1: MEM-PERSIST-READ-001 — Read-only memory summary bridge

Add a bootstrap hook or system-prompt entry that reads jinhee.db (`canonical_memories` + top `memories`) and injects a concise summary into the agent context alongside MEMORY.md. This bridges the gap without modifying OpenClaw memory runtime.

### Candidate 2: MEM-PERSIST-WRITE-001 — Conversation → memories append-only

After each Telegram conversation, extract key facts and append to `conversation_logs` or `memories` in jinhee.db. Requires careful append-only design (no UPDATE/DELETE).

### Candidate 3: MEM-PERSIST-GUARD-001 — DB write guard + test isolation

Add a wrapper that forces `mode=ro` for all non-authorized DB connections and separate test DB paths to prevent test → prod collisions.

### Candidate 4: MEM-PERSIST-INDEX-001 — Memory retrieval index

Add a lightweight summary of jinhee.db's canonical_memories into a regularly auto-refreshed `CORE_MEMORY_SNAPSHOT.md` so MEMORY.md stays current without manual curation.

---

## 11. Do Not Touch List

- `~/.openclaw/memory/main.sqlite` — OpenClaw internal, do not read/write directly
- `~/.openclaw/state/openclaw.sqlite` — OpenClaw internal state
- `jinhee.db` full schema — No ALTER/DROP/MIGRATION
- `nl_router.py` — Active router, do not hotfix
- `src/agents/workspace.ts` — Core bootstrap logic
- `src/agents/system-prompt.ts` — Core system prompt
- `package.json` / `pnpm-lock.yaml` — No dependency changes

---

## 12. Recommended Next Ticket

**MEM-PERSIST-READ-001** — Read-only memory summary bridge

This is the highest-value, lowest-risk first step:

- Adds no runtime memory load (read-only)
- Doesn't modify OpenClaw core modules
- Connects jinhee.db → agent context without duplication
- Can be implemented as a standalone bootstrap hook or simple system-prompt augmentation
- Falls back gracefully if jinhee.db is unavailable

Expected impact: Agent has access to canonical memories + important facts from jinhee.db alongside MEMORY.md content.

---

## 13. Final Verification

- ✅ Code/runtime changes: **none** (docs/audit only)
- ✅ DB file changes: **none** (read-only queries only)
- ✅ package.json/pnpm-lock.yaml changes: **none**
- ✅ Config/secrets/model changes: **none**
- ✅ Gateway restart: **none**
- ✅ git diff before/after: **no new changes**
