# Local Memory Search — Implementation Plan & Setup Log

## Decision

**Use QMD (Option 2)** — OpenClaw's built-in QMD backend integration.

QMD is a local-first search sidecar that combines BM25 + vectors + reranking.
It integrates seamlessly into OpenClaw: same `memory_search` / `memory_get`
tools, just better retrieval under the hood. No API keys, no cloud dependency,
fully offline.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   OpenClaw Gateway               │
│                                                  │
│  memory_search() ──► QMD Manager ──► qmd CLI     │
│  memory_get()    ──► Filesystem (Markdown)        │
│                                                  │
│  Fallback: if QMD fails → built-in SQLite search │
└──────────────────────────────────────────────────┘

QMD State: ~/.openclaw/agents/<agentId>/qmd/
├── xdg-config/        # QMD config (auto-managed by OpenClaw)
├── xdg-cache/         # QMD's SQLite index
└── sessions/          # Exported session transcripts (if enabled)

Model Cache: ~/.cache/qmd/models/    ← NOTE: uses default cache, NOT xdg-cache
├── hf_ggml-org_embeddinggemma-300M-Q8_0.gguf           (~313MB)
├── hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf       (~1.28GB)
└── hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf           (~639MB)

Source of Truth: ~/.openclaw/workspace/
├── MEMORY.md          # Curated long-term memory
└── memory/
    └── YYYY-MM-DD.md  # Daily logs
```

---

## Installation Log (2026-02-15)

### Environment

| Component    | Details                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| **Machine**  | Mac mini (Apple Silicon, arm64)                                                |
| **OS**       | Darwin 25.2.0                                                                  |
| **OpenClaw** | v2026.2.14                                                                     |
| **Bun**      | 1.3.8 (pre-installed at `/Users/rohits/Library/PhpWebStudy/app/bun/1.3.8/bun`) |
| **SQLite**   | 3.51.0 (`/usr/bin/sqlite3`)                                                    |
| **Node**     | v24.13.0                                                                       |

### Step 1: Install QMD via Bun

```bash
/Users/rohits/Library/PhpWebStudy/app/bun/1.3.8/bun install -g https://github.com/tobi/qmd
```

**Result:** Installed to `/Users/rohits/.bun/bin/qmd` (symlink to
`../install/global/node_modules/qmd/qmd`)

**⚠️ GOTCHA: QMD needs Bun on PATH to run.** The `qmd` binary is a Bun script
that starts with a shebang requiring `bun`. If `bun` isn't on PATH, you get:
`Error: bun not found. Install from https://bun.sh`

**Fix:** Symlink bun into the same directory:

```bash
ln -s /Users/rohits/Library/PhpWebStudy/app/bun/1.3.8/bun /Users/rohits/.bun/bin/bun
```

### Step 2: Make QMD Accessible to the Gateway

**⚠️ CRITICAL GOTCHA: The OpenClaw gateway process does NOT inherit `~/.zshrc`.**

Adding `export PATH="/Users/rohits/.bun/bin:$PATH"` to `~/.zshrc` does NOT help
the gateway find `qmd`. The gateway is a background service that doesn't source
shell profiles.

**What DOES work — two things needed:**

**A. Set `memory.qmd.command` to the full absolute path in config:**

```json5
memory: {
  qmd: {
    command: "/Users/rohits/.bun/bin/qmd"
  }
}
```

This fixes `qmd query` (search calls). BUT — some internal operations like
`qmd update` and `qmd collection add` may still use bare `qmd` from PATH.

**B. Add PATH to `~/.openclaw/.env` (this is what actually fixed it):**

```bash
echo 'PATH=/Users/rohits/.bun/bin:${PATH}' >> ~/.openclaw/.env
```

OpenClaw reads `~/.openclaw/.env` on startup and merges it into the gateway
process environment. This ensures ALL QMD subprocesses can find both `qmd` and
`bun`.

**⚠️ Without BOTH fixes, you'll see:**

```
[memory] qmd collection add failed for memory-root: spawn qmd ENOENT
[memory] qmd boot update failed: Error: spawn qmd ENOENT
```

### Step 3: Apply Config

```json5
// Added to ~/.openclaw/openclaw.json
memory: {
  backend: "qmd",
  qmd: {
    command: "/Users/rohits/.bun/bin/qmd",
    searchMode: "query",
    update: {
      commandTimeoutMs: 60000
    },
    limits: {
      timeoutMs: 15000   // ← IMPORTANT: default 4000ms is too short
    }
  }
}
```

Applied via:

```bash
# Or use gateway config.patch tool
```

**⚠️ CRITICAL GOTCHA: The `memory` config key requires a full gateway restart.**
Hot reload is NOT sufficient. OpenClaw logs:

```
[reload] config change requires gateway restart (memory)
```

It does auto-restart via SIGUSR1, but draining active tasks can take 30+ seconds.

### Step 4: First-Time Model Downloads

**⚠️ GOTCHA: QMD auto-downloads 3 GGUF models on first use (~2.2GB total).**

| Model                                  | Size    | Purpose         | When Downloaded       |
| -------------------------------------- | ------- | --------------- | --------------------- |
| `embeddinggemma-300M-Q8_0.gguf`        | ~313MB  | Embeddings      | On `qmd embed` (boot) |
| `qmd-query-expansion-1.7B-q4_k_m.gguf` | ~1.28GB | Query expansion | On first `qmd query`  |
| `qwen3-reranker-0.6b-q8_0.gguf`        | ~639MB  | Reranking       | On first `qmd query`  |

**Download location:** `~/.cache/qmd/models/` (NOT under OpenClaw's XDG dirs)

**Download speed:** ~14-17MB/s on our connection. Total time: ~3-5 minutes.

**⚠️ GOTCHA: Downloads resume on retry.** If a download is interrupted (process
killed), the next `qmd query` resumes from where it left off. No need to start over.

### Step 5: First Query Timeout Problem

**⚠️ CRITICAL GOTCHA: First `qmd query` after gateway restart is SLOW.**

QMD loads all 3 GGUF models into memory on the first query. This takes 5-15
seconds depending on the machine. The default `timeoutMs: 4000` causes this flow:

1. Gateway boots → `qmd update` + `qmd embed` run (OK, these are fast)
2. First `memory_search` call triggers `qmd query`
3. QMD starts loading models into RAM
4. 4 seconds pass → OpenClaw times out
5. **OpenClaw permanently switches to builtin SQLite for this boot cycle**
6. Builtin SQLite needs API keys (OpenAI/Google/Voyage) → fails with "No API key"
7. `memory_search` returns `disabled: true` for the rest of the session

**Fix:** Set `limits.timeoutMs: 15000` (15 seconds) in config. This gives QMD
enough time to load models on the first cold query.

**After models are loaded,** subsequent queries are fast (~1-2 seconds).

### Step 6: Pre-Warming (Recommended)

To avoid the cold-start timeout, pre-warm QMD after install or gateway restart:

```bash
export PATH="/Users/rohits/.bun/bin:$PATH"
export XDG_CONFIG_HOME="$HOME/.openclaw/agents/main/qmd/xdg-config"
export XDG_CACHE_HOME="$HOME/.openclaw/agents/main/qmd/xdg-cache"

# Index files
qmd update
qmd embed

# Trigger model loading (first query is slow, rest are fast)
qmd query "test" --json -c memory-root -c memory-alt -c memory-dir > /dev/null 2>&1
```

### Step 7: Verify

```bash
# Check QMD collections
export PATH="/Users/rohits/.bun/bin:$PATH"
export XDG_CONFIG_HOME="$HOME/.openclaw/agents/main/qmd/xdg-config"
export XDG_CACHE_HOME="$HOME/.openclaw/agents/main/qmd/xdg-cache"
qmd collection list
```

Expected output:

```
Collections (3):

memory-root (qmd://memory-root/)
  Pattern:  MEMORY.md
  Files:    0-1  (0 if MEMORY.md doesn't exist yet)

memory-alt (qmd://memory-alt/)
  Pattern:  memory.md

memory-dir (qmd://memory-dir/)
  Pattern:  **/*.md
  Files:    N   (files in memory/ directory)
```

**In OpenClaw,** `memory_search` results should show:

```json
{
  "provider": "qmd",
  "model": "qmd",
  "citations": "auto"
}
```

If you see `"disabled": true` with API key errors, QMD failed and fell back to
builtin. Check `~/.openclaw/logs/gateway.err.log` for timeout/ENOENT errors.

---

## Final Working Config

```json5
// ~/.openclaw/openclaw.json (relevant section)
{
  memory: {
    backend: "qmd",
    qmd: {
      command: "/Users/rohits/.bun/bin/qmd",
      searchMode: "query",
      update: {
        commandTimeoutMs: 60000,
      },
      limits: {
        timeoutMs: 15000,
      },
    },
  },
}
```

```bash
# ~/.openclaw/.env (required for gateway to find qmd/bun)
PATH=/Users/rohits/.bun/bin:${PATH}
```

```bash
# ~/.zshrc (for interactive shell use of qmd)
export PATH="/Users/rohits/.bun/bin:$PATH"
```

---

## File Locations Reference

| What                 | Path                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------ |
| QMD binary           | `/Users/rohits/.bun/bin/qmd` → `../install/global/node_modules/qmd/qmd`              |
| Bun binary           | `/Users/rohits/.bun/bin/bun` → `/Users/rohits/Library/PhpWebStudy/app/bun/1.3.8/bun` |
| QMD state (OpenClaw) | `~/.openclaw/agents/main/qmd/`                                                       |
| QMD XDG config       | `~/.openclaw/agents/main/qmd/xdg-config/`                                            |
| QMD XDG cache        | `~/.openclaw/agents/main/qmd/xdg-cache/`                                             |
| QMD SQLite index     | `~/.openclaw/agents/main/qmd/xdg-cache/qmd/index.sqlite`                             |
| GGUF models (shared) | `~/.cache/qmd/models/`                                                               |
| OpenClaw config      | `~/.openclaw/openclaw.json`                                                          |
| OpenClaw env         | `~/.openclaw/.env`                                                                   |
| Gateway log          | `~/.openclaw/logs/gateway.log`                                                       |
| Gateway error log    | `~/.openclaw/logs/gateway.err.log`                                                   |

---

## Troubleshooting Checklist

### "spawn qmd ENOENT"

- **Cause:** Gateway can't find `qmd` on PATH
- **Fix:** Add `PATH=/Users/rohits/.bun/bin:${PATH}` to `~/.openclaw/.env`
- **Also:** Set `memory.qmd.command` to full path in config

### "timed out after 4000ms"

- **Cause:** First query loads GGUF models (~5-15s), default timeout is 4s
- **Fix:** Set `memory.qmd.limits.timeoutMs: 15000` in config
- **Prevention:** Pre-warm with `qmd query "test" --json` after restart

### "qmd memory failed; switching to builtin index"

- **Cause:** QMD failed (timeout or ENOENT) → OpenClaw switches to builtin SQLite
- **Effect:** Builtin needs API keys → "No API key" error → `disabled: true`
- **Fix:** Fix the underlying issue (PATH or timeout), then restart gateway
- **Note:** This switch is **permanent for the boot cycle** — you MUST restart

### "No API key found for provider openai/google/voyage"

- **Cause:** QMD failed and fell back to builtin, which needs embedding API keys
- **NOT the fix:** Adding API keys (that just makes the fallback work)
- **Actual fix:** Fix QMD so it doesn't fall back (see above)

### QMD collections show 0 files for MEMORY.md

- **Cause:** `MEMORY.md` doesn't exist in workspace
- **Fix:** Create it: `touch ~/.openclaw/workspace/MEMORY.md`

### Model download interrupted

- **Cause:** Process killed during GGUF download
- **Fix:** Just retry — downloads resume from where they left off
- **Location:** Check `~/.cache/qmd/models/` for partial downloads

---

## Known Limitations

1. **First query after restart is slow** (~5-15s model loading). No way around
   this — GGUF models must be loaded into RAM. Pre-warming helps.

2. **QMD models download to `~/.cache/qmd/models/`**, not under OpenClaw's XDG
   dirs. This means pre-warming with XDG vars set won't pre-download models to
   the right place. Models are shared across all QMD instances.

3. **Once QMD fails and switches to builtin, it stays on builtin** until gateway
   restart. There's no mid-session recovery.

4. **`memory.qmd.command` only affects search queries.** Boot operations like
   `qmd collection add` and `qmd update` may still use bare `qmd` from PATH.
   That's why `~/.openclaw/.env` PATH is essential.

5. **Total model disk usage:** ~2.2GB in `~/.cache/qmd/models/`. These persist
   across restarts and are shared by all QMD instances.

---

## Post-Setup Enhancements

### A. Index Session Transcripts

Makes past conversations searchable:

```json5
memory: {
  backend: "qmd",
  qmd: {
    sessions: {
      enabled: true,
      retentionDays: 30,
    },
  },
},
```

### B. Index Project Docs

```json5
memory: {
  backend: "qmd",
  qmd: {
    paths: [
      { name: "openclaw-docs", path: "/Users/rohits/dev/operator1/docs", pattern: "**/*.md" },
    ],
  },
},
```

### C. Index Personal Notes

```json5
memory: {
  backend: "qmd",
  qmd: {
    paths: [
      { name: "notes", path: "~/Documents/notes", pattern: "**/*.md" },
    ],
  },
},
```

---

## Quick Reinstall Guide (Future Reference)

If setting up QMD on a new machine or after a clean install:

```bash
# 1. Install Bun (if not present)
curl -fsSL https://bun.sh/install | bash

# 2. Install QMD
bun install -g https://github.com/tobi/qmd

# 3. Ensure bun is alongside qmd (if not already)
ls ~/.bun/bin/bun || ln -s $(which bun) ~/.bun/bin/bun

# 4. Add PATH to OpenClaw env
echo 'PATH=$HOME/.bun/bin:${PATH}' >> ~/.openclaw/.env

# 5. Add config (adjust command path for your system)
# Add to ~/.openclaw/openclaw.json:
# memory: {
#   backend: "qmd",
#   qmd: {
#     command: "$HOME/.bun/bin/qmd",  ← use absolute path
#     searchMode: "query",
#     limits: { timeoutMs: 15000 },
#     update: { commandTimeoutMs: 60000 }
#   }
# }

# 6. Restart gateway
openclaw gateway restart

# 7. Pre-warm (wait for model downloads ~2.2GB, then load into RAM)
export XDG_CONFIG_HOME="$HOME/.openclaw/agents/main/qmd/xdg-config"
export XDG_CACHE_HOME="$HOME/.openclaw/agents/main/qmd/xdg-cache"
qmd update && qmd embed
qmd query "test" --json -c memory-root -c memory-alt -c memory-dir > /dev/null 2>&1

# 8. Verify
qmd collection list
# Then test memory_search in OpenClaw — should show provider: "qmd"
```

---

## UI Feature: Memory Management (ui-next)

This section defines a **Memory** tab under Agents in the ui-next dashboard.

### How Memory Works in OpenClaw (Background)

There are **four mechanisms** that add/read memory:

#### 1. Agent Writes Explicitly

When the agent decides something is worth remembering (or the user says
"remember this"), it uses `write`/`edit` tools to append to
`memory/YYYY-MM-DD.md` or update `MEMORY.md`. No special memory API — just
Markdown file editing.

#### 2. Pre-Compaction Memory Flush (Automatic)

When a session approaches the context window limit, OpenClaw triggers a
**silent agent turn** before compaction:

> "Session is about to be compacted. Write important notes to memory NOW."

The agent writes durable facts to `memory/YYYY-MM-DD.md` before context is
trimmed. Controlled by `agents.defaults.compaction.memoryFlush` (on by default).

#### 3. Heartbeat → Memory Review (Behavioral)

**The heartbeat–memory link:** During periodic heartbeat turns (every 30m),
the agent can:

- **Read** memory files to check pending tasks/follow-ups
- **Write** new observations ("checked email, nothing urgent")
- **Curate** — move important things from daily logs → `MEMORY.md`

This is defined in `AGENTS.md` workspace instructions:

> _"Periodically (every few days), use a heartbeat to: read recent daily
> files, identify significant insights, update MEMORY.md with distilled
> learnings, remove outdated info."_

The heartbeat is the agent's **reflection time** — it's behavioral (agent must
be instructed via SOUL.md/AGENTS.md/HEARTBEAT.md to do memory maintenance),
not automatic infrastructure.

#### 4. QMD Indexing (Background, Read-Side Only)

QMD doesn't write memory — it indexes what's already written. Every 5 minutes,
`qmd update` + `qmd embed` re-scan the Markdown files and update the vector
index. Purely read-side — makes existing memory searchable via `memory_search`.

---

### UI Tab Structure

```
Sidebar: Agents
  └── [Click agent]
        ├── Workspace (existing proposal #6)
        │     ├── SOUL.md
        │     ├── IDENTITY.md
        │     ├── USER.md
        │     └── TOOLS.md
        ├── Memory (NEW)                  ← this feature
        │     ├── Files
        │     ├── Search
        │     ├── Index Status
        │     └── Activity Log
        └── Heartbeat (existing proposal #7)
```

Within the Memory tab:

```
Memory
├── 📋 Memory Files        (browse/edit MEMORY.md + daily files)
├── 🔍 Search              (semantic search via memory_search)
├── 📊 Index Status         (QMD health, indexed files, last sync)
└── 📜 Activity Log         (what was written/read and when)
```

---

### A. Memory Files (Browse & Edit)

Maps to **ui-next proposal #6 (Memory & Workspace File Browser)** but scoped
to memory files specifically.

| What to Show                    | Source                                    |
| ------------------------------- | ----------------------------------------- |
| `MEMORY.md` contents (editable) | `agents.files.get` / `agents.files.set`   |
| `memory/YYYY-MM-DD.md` list     | `agents.files.list` filtered to `memory/` |
| File size, last modified        | Filesystem metadata                       |
| Daily file timeline             | List sorted by date, newest first         |

**User actions:** View, edit, create new daily file, delete old files.

**UI Components:**

- `ResizablePanel` — file list sidebar + editor main area
- `Textarea` or CodeMirror for editing
- `Calendar`-style date picker for navigating daily files
- "Unsaved changes" indicator + auto-save to localStorage

---

### B. Search

Interactive semantic search — a UI for `memory_search`.

| What to Show                      | Source                               |
| --------------------------------- | ------------------------------------ |
| Search input box                  | User input                           |
| Results with highlighted snippets | `memory_search` response             |
| Source file + line number         | `citation` field                     |
| Relevance score                   | `score` field                        |
| Backend indicator                 | `provider` field ("qmd" / "builtin") |
| Click-to-open source              | Links to Memory Files tab            |

**User actions:** Type query, browse results, click to open source file at
the matching line.

**UI Components:**

- `Input` with search icon
- `Card` per result (snippet, score badge, source link)
- Search history dropdown (last 10-20 queries, localStorage)

**Implementation:**

```typescript
// memory_search is currently a tool, not an RPC
// Option A: Expose as RPC (needs gateway change)
const results = await gatewayClient.request("memory.search", { query, maxResults: 10 });

// Option B: Use existing tool invocation
// Requires agent session context — less ideal for UI
```

**Recommendation:** Propose a `memory.search` RPC endpoint in the gateway so
the UI can call it directly without going through an agent session.

---

### C. Index Status

"Is QMD healthy?" dashboard.

| What to Show           | Source                                        |
| ---------------------- | --------------------------------------------- |
| Backend type           | `qmd` / `builtin` / `disabled`                |
| Health status          | ✅ Healthy / ⚠️ Fallback active / ❌ Disabled |
| Collections registered | Collection name, pattern, file count          |
| Last index update      | Timestamp from QMD metadata                   |
| Models loaded          | Check `~/.cache/qmd/models/`                  |
| Total index size       | SQLite file size                              |
| Search provider in use | From `memory_search` response                 |

**Alerts to surface:**

- ⚠️ "QMD fell back to builtin" (timeout/failure)
- ⚠️ "No files indexed" (MEMORY.md doesn't exist)
- ⚠️ "Index stale" (last sync > 15 minutes ago)
- ✅ "QMD healthy, N files indexed, last sync Xm ago"

**UI Components:**

- Status `Badge` (green/yellow/red)
- `Table` for collections
- `Alert` for warnings
- "Re-index now" `Button` (triggers `qmd update && qmd embed`)

**Gateway API needed (new):**

```typescript
// Proposed new RPC: memory.status
const status = await gatewayClient.request('memory.status', {});
// Returns:
{
  backend: "qmd",
  provider: "qmd",
  healthy: true,
  fallbackActive: false,
  collections: [
    { name: "memory-root", pattern: "MEMORY.md", files: 1, lastSync: "..." },
    { name: "memory-dir", pattern: "**/*.md", files: 5, lastSync: "..." },
  ],
  filesIndexed: 6,
  indexSizeBytes: 1258000,
  models: [
    { name: "embeddinggemma-300M", size: "313MB", loaded: true },
    { name: "qmd-query-expansion-1.7B", size: "1.28GB", loaded: true },
    { name: "qwen3-reranker-0.6b", size: "639MB", loaded: true },
  ],
  lastSync: "2026-02-15T06:07:33Z",
}
```

---

### D. Activity Log

**New feature** — not in any current proposal. Makes memory transparent.

Shows a timeline of all memory reads and writes:

**Memory Writes (additions):**

| Column           | Source                                                         |
| ---------------- | -------------------------------------------------------------- |
| Timestamp        | Tool call timestamp from session JSONL                         |
| File modified    | `path` argument to `write`/`edit` tool                         |
| What was written | `content` argument (or diff)                                   |
| Trigger          | Which session/mechanism caused it                              |
| Trigger type     | `explicit` / `compaction-flush` / `heartbeat` / `user-request` |

**Memory Reads (retrievals):**

| Column           | Source                                  |
| ---------------- | --------------------------------------- |
| Timestamp        | Tool call timestamp                     |
| Query            | `query` argument to `memory_search`     |
| Results returned | Count + top snippet                     |
| Session context  | Which conversation triggered the search |

**Where this data comes from:**

- Session transcripts (JSONL) contain every tool call
- Parse `write`, `edit`, `memory_search` tool calls from transcripts
- Gateway API: `sessions.history` with `includeTools: true`
- Filter to tool calls where path contains `memory/` or `MEMORY.md`

**UI Components:**

- `Timeline` or `Table` view (toggle)
- Filter by type: Writes / Reads / All
- Filter by trigger: Explicit / Compaction / Heartbeat
- Date range picker
- Click entry → shows full details (what was written, search results)

**Implementation sketch:**

```typescript
// Fetch recent sessions and parse tool calls
const sessions = await gatewayClient.request("sessions.list", {
  activeMinutes: 60 * 24 * 7, // last 7 days
  kinds: ["main", "cron"],
});

for (const session of sessions) {
  const history = await gatewayClient.request("sessions.history", {
    sessionKey: session.key,
    includeTools: true,
    limit: 200,
  });

  // Filter for memory-related tool calls
  const memoryOps = history.messages.filter(
    (msg) =>
      msg.role === "toolResult" &&
      (msg.toolName === "memory_search" ||
        (msg.toolName === "write" && msg.args?.path?.includes("memory")) ||
        (msg.toolName === "edit" && msg.args?.path?.includes("memory"))),
  );
}
```

---

### E. Memory Maintenance Panel

Visualizes the heartbeat–memory connection:

```
┌─────────────────────────────────────────┐
│  Memory Maintenance                      │
│                                          │
│  Last heartbeat:     12 min ago ✅        │
│  Memory reviewed:    Yes (wrote 2 notes) │
│  MEMORY.md updated:  3 days ago          │
│  Daily files:        14 files, 12KB      │
│                                          │
│  Maintenance behaviors:                  │
│  ┌─────────────────────────────────┐    │
│  │ ☑ Review daily files (heartbeat)│    │
│  │ ☑ Curate MEMORY.md (weekly)     │    │
│  │ ☑ Pre-compaction flush (auto)   │    │
│  │ ☐ Index session transcripts     │    │
│  └─────────────────────────────────┘    │
└──────────────────────────────────────────┘
```

**Checkbox mappings to config:**

| Checkbox                  | Config / File                                    |
| ------------------------- | ------------------------------------------------ |
| Review daily files        | `HEARTBEAT.md` includes memory review task       |
| Curate MEMORY.md          | Cron job or `HEARTBEAT.md` instruction           |
| Pre-compaction flush      | `agents.defaults.compaction.memoryFlush.enabled` |
| Index session transcripts | `memory.qmd.sessions.enabled`                    |

**User actions:** Toggle behaviors on/off (writes to config or HEARTBEAT.md).

---

### Gateway API Requirements Summary

| Feature             | API                         | Exists?      | Action                       |
| ------------------- | --------------------------- | ------------ | ---------------------------- |
| Browse memory files | `agents.files.list/get/set` | ✅           | Use as-is                    |
| Semantic search     | `memory_search` (tool)      | ✅ Tool only | Propose `memory.search` RPC  |
| Index status        | —                           | ❌           | Propose `memory.status` RPC  |
| QMD collections     | —                           | ❌           | Include in `memory.status`   |
| Re-index trigger    | —                           | ❌           | Propose `memory.reindex` RPC |
| Activity log        | `sessions.history` + parse  | ✅ Raw data  | Client-side parsing          |
| Maintenance config  | `config.get/patch`          | ✅           | Use as-is                    |

**New RPCs to propose:**

```typescript
// 1. memory.status — read-only health check
gateway.request('memory.status', { agentId?: string })
// Returns: backend, health, collections, models, sync status

// 2. memory.search — direct search without agent session
gateway.request('memory.search', { query: string, maxResults?: number, agentId?: string })
// Returns: same shape as memory_search tool

// 3. memory.reindex — trigger re-index
gateway.request('memory.reindex', { agentId?: string })
// Returns: { ok: true, filesIndexed: N }
```

---

### Build Priority

| Priority | Feature             | Effort | Depends On                              |
| -------- | ------------------- | ------ | --------------------------------------- |
| **P0**   | Memory file browser | Medium | `agents.files.*` API (exists)           |
| **P0**   | Search UI           | Medium | `memory.search` RPC (new) or tool proxy |
| **P1**   | Index status        | Small  | `memory.status` RPC (new)               |
| **P2**   | Activity log        | Large  | `sessions.history` parsing              |
| **P2**   | Maintenance panel   | Medium | Config read/write + HEARTBEAT.md        |
| **P3**   | Memory analytics    | Medium | Activity log data                       |

---

### Zustand Store

```typescript
// src/store/memory-store.ts
interface MemoryStore {
  // Files
  files: MemoryFile[];
  selectedFile: string | null;
  fileContent: string;
  unsavedChanges: boolean;

  // Search
  searchQuery: string;
  searchResults: SearchResult[];
  searchHistory: string[]; // localStorage persisted
  searching: boolean;

  // Index status
  indexStatus: {
    backend: "qmd" | "builtin" | "disabled";
    healthy: boolean;
    fallbackActive: boolean;
    collections: Collection[];
    filesIndexed: number;
    lastSync: string;
  } | null;

  // Activity log
  activityLog: MemoryActivity[];
  activityFilter: "all" | "writes" | "reads";

  // Actions
  loadFiles: () => Promise<void>;
  loadFile: (path: string) => Promise<void>;
  saveFile: (path: string, content: string) => Promise<void>;
  search: (query: string) => Promise<void>;
  loadIndexStatus: () => Promise<void>;
  reindex: () => Promise<void>;
  loadActivityLog: (days: number) => Promise<void>;
}
```

---

_Installed: 2026-02-15_
_Last updated: 2026-02-15_
_Status: ✅ Working (QMD backend, fully local, zero API keys)_
