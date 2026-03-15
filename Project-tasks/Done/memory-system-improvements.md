# Operator1 Memory System — Functional Review & Improvement Plan

**Created:** 2026-03-13
**Author:** Operator1 (COO)
**Status:** Implementation Guide
**Depends on:** SQLite consolidation (Phases 0–11 landed), ui-next control panel, QMD backend

---

## 1. Functional Review — Current State

### 1.1 Architecture Summary

The memory system is a four-layer model:

| Layer                | Storage                                            | Purpose                                | Update Pattern                               |
| -------------------- | -------------------------------------------------- | -------------------------------------- | -------------------------------------------- |
| **Daily Notes**      | `memory/YYYY-MM-DD.md`                             | Raw session capture                    | Auto-flush before compaction + manual writes |
| **Long-Term Memory** | `MEMORY.md`                                        | Curated decisions, people, preferences | Manual distillation from daily notes         |
| **Project Memory**   | `~/.openclaw/workspace/projects/{id}/memory/`      | Project-scoped context                 | Manual + heartbeat maintenance               |
| **Semantic Search**  | QMD index (`memory/main.sqlite`) or builtin SQLite | Vector-searchable knowledge base       | Auto-reindex on changes (5m interval)        |

Two backends: **QMD** (preferred — hybrid BM25 + vector + reranking) and **builtin** (BM25 FTS5 + optional sqlite-vec embeddings).

### 1.2 Production Usage Data (2026-03-13)

**RPC call distribution (last 24h):**

- `memory.status`: 23 calls (health checks — UI polling)
- `memory.reindex`: 16 calls (indexing updates)
- `memory.activity`: 16 calls (activity tracking)
- `memory.search`: **8 calls** (actual content search — lowest!)

**Key finding:** Status/reindex/activity calls dominate. Actual search queries are rare — only 8 in 24 hours. This suggests agents aren't searching memory as aggressively as intended, or the mandatory recall prompt isn't triggering reliably.

**Agent memory distribution:**

- **main**: 31 sessions, 12 daily notes (56 KB total) — heavy user
- **neo**: 2 sessions, 2 memory files
- **morpheus**: 2 sessions, 1 memory file
- **30 other agents**: 0 sessions, 0 memory files — completely dormant

**Performance:**

- Search latency: 52ms (best) → 45,827ms (worst), median ~13s
- Reindex: up to 121,059ms (2+ minutes) for full reindex
- QMD timeouts: historical 4000ms timeouts (Feb 15) with fallback to FTS
- Memory SQLite: 68 KB indexed; State DB: 23.2 MB + 22.9 MB WAL

### 1.3 Memory Flush — How It Works

Pre-compaction flush triggers when tokens approach context window limit:

```
Trigger: totalTokens >= (contextWindow - reserveTokensFloor - softThresholdTokens)
Default softThreshold: 4,000 tokens
Secondary trigger: transcript file > 2 MB
```

The agent receives a flush prompt asking it to APPEND to `memory/YYYY-MM-DD.md`. If nothing to save, the agent responds with `░` and the transcript is pruned (invisible heartbeat).

**Observed issues:**

- Flush relies on token estimates that can be stale
- No feedback to user when flush occurs (silent)
- No validation that the agent actually wrote useful content
- Daily notes can accumulate unboundedly — no retention policy

### 1.4 Heartbeat System — How It Works

Periodic self-check (default: every 30m) driven by `HEARTBEAT.md` instructions:

```
requestHeartbeatNow() → queuePendingWakeReason() → runHeartbeatOnce()
  1. Check HEARTBEAT.md is non-empty
  2. Resolve session (default: main)
  3. Call model with heartbeat prompt
  4. If HEARTBEAT_OK → prune transcript (invisible)
  5. If content → deliver to target channel
  6. Schedule next heartbeat
```

**Current HEARTBEAT.md tasks:**

- QMD keepalive (run `memory_search` every heartbeat)
- Memory maintenance (distill daily notes → MEMORY.md every few days)
- State tracked in `memory/heartbeat-state.json`

**Observed issues:**

- Heartbeat runs on main agent only — subagents don't have heartbeats
- Memory maintenance task ("distill daily notes") relies on agent initiative — no enforcement
- No UI visibility into heartbeat history or scheduling
- `heartbeat-state.json` is agent-managed (fragile — agent can forget to update it)
- No heartbeat analytics (success rate, avg duration, skip reasons)

### 1.5 UI — Current State

Four-tab Memory page (`ui-next/src/pages/memory.tsx`, 1382 lines):

| Tab              | What It Does                                         | Gaps                                                                                   |
| ---------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Index Status** | Provider health, file/chunk counts, embedding status | No scope config, no stale-index banner, no embedding provider switcher                 |
| **Files**        | Flat file list → textarea editor                     | No create/delete/rename, no tree view, no markdown preview, no diff, no project memory |
| **Search**       | Text input → results table                           | No source/date/score filters, no path filtering, search→files nav fragile              |
| **Activity**     | Scans raw JSONL → operation log                      | Slow (O(n) over all sessions), no date filter, no SQLite backing, 20-item pages        |

**Missing entirely:**

- Memory scope configuration (extraPaths, sources, session indexing)
- Project memory management
- Embedding provider management
- Heartbeat dashboard (schedule, history, state)
- Memory analytics/insights
- File manager operations (create, delete, rename, move)
- Memory import/export

---

## 2. Identified Issues — Prioritized

### 2.1 Functional Issues (things that are broken or underperforming)

**F1. Agents barely search memory (8 searches/day)**
The "mandatory recall" prompt in the system prompt says to search before answering questions about prior work, but production data shows only 8 `memory.search` calls in 24 hours across all agents. Either the prompt isn't strong enough, agents skip it, or most conversations don't trigger the recall heuristic.

**F2. Reindex is too slow (2+ minutes)**
Full reindex takes 121 seconds. During this time, searches may return stale results. No incremental indexing — it's always a full scan.

**F3. Search latency variance is extreme (52ms to 46s)**
13s median is acceptable but the 46s worst-case blocks agent turns. No timeout on the agent side — the model waits indefinitely for `memory_search` to return.

**F4. Memory flush has no verification**
After a flush turn, there's no check that the agent actually wrote content. The agent might respond with `░` even when it should have written. No logging of what was flushed vs. what was discarded.

**F5. Daily notes accumulate forever**
No retention policy. A busy agent will accumulate hundreds of daily note files. No auto-distillation into MEMORY.md. The heartbeat "memory maintenance" task is aspirational — it depends on the agent remembering to do it.

**F6. 30/34 agents have zero memory**
Most agents in the matrix never use memory because they rarely run sessions. When they do run (as subagents), they may not have a warm index. First search is cold → slow.

**F7. Activity log scans raw JSONL on every call**
`memory.activity` reads all `.jsonl` session files from disk on every RPC call. For agents with many sessions, this is O(total_session_bytes). No caching, no incremental scan, no SQLite backing.

### 2.2 UI Bugs (broken user-facing flows — fix first)

**B1. Search→Files fails for session results (blank content pane)**
When a search result is a QMD-indexed session file (e.g. `qmd/sessions-main/edd6f4ea-e247-439c-9a2c-b84934bc47bd.md`), clicking "View in Files" switches to the Files tab and sets the filename in the header — but the content pane is blank. The file never loads.

**Root cause:** `handleResultClick()` at `ui-next/src/pages/memory.tsx:982` passes `result.path` directly to `getMemoryFile(agentId, fileName)` which calls the `agents.files.get` RPC. But the gateway handler (`src/gateway/server-methods/agents.ts`) only allows paths that are within the agent's workspace directory — `qmd/sessions-main/...` paths are QMD's internal collection paths (pointing to session export files at `~/.openclaw/agents/<id>/qmd/sessions/`), not workspace-relative paths.

**Fix (two parts):**

1. **For session results:** Don't navigate to the Files tab at all. Instead, show the snippet content in-place (expandable) or open a read-only modal with the full chunk context. Session transcripts are not editable files — navigating to the file manager is the wrong UX.
2. **For memory results:** Continue navigating to Files tab, but add error handling: if `agents.files.get` fails, show "File not found in workspace" message instead of a blank pane.

**Implementation:**

```typescript
// memory.tsx — handleResultClick
const handleResultClick = (result: MemorySearchResultUI) => {
  if (result.source === "sessions" || result.path.startsWith("qmd/")) {
    // Session results: expand snippet inline or show read-only modal
    store.setExpandedResult(result);
    return;
  }
  // Memory file results: navigate to Files tab (existing behavior)
  store.setActiveTab("files");
  store.setSelectedFile(result.path);
  store.setHighlightLine(result.startLine);
  store.setHighlightTerm(store.searchQuery); // NEW: pass search terms
  if (agentId) void getMemoryFile(agentId, result.path);
};
```

**B2. No keyword highlighting when navigating to Files tab from search**
After clicking a memory file search result and navigating to the Files tab, the matched line is scrolled into view and selected — but the actual search keywords are not highlighted. The user can't see _why_ this line matched. Compare with docs search (`ui-next/src/pages/docs.tsx`) which uses the `HighlightText` component (`docs.tsx:85`) to inject `<mark>` tags into rendered content and scroll to the first match.

**Root cause:** The Files tab uses a plain `<textarea>` editor (`memory.tsx:688-707`). The current approach is:

1. Calculate line height from `scrollHeight / lines.length`
2. Scroll to `(highlightLine - 3) * lineHeight`
3. Select the entire line via `setSelectionRange()`
4. Clear highlight state

This selects the whole line (not the matching keywords) and the textarea doesn't support rich formatting like `<mark>` tags.

**Fix (inspired by docs search `HighlightText` component at `docs.tsx:85`):**

Option A — **Overlay highlight on textarea** (simpler):

- Add a semi-transparent overlay `<div>` positioned behind the textarea
- Render the file content in the overlay with `<mark>` tags wrapping search terms
- Sync scroll position between overlay and textarea
- This is the "highlight textarea" pattern used by many code editors

Option B — **Replace textarea with rendered markdown + inline editor** (better long-term):

- Render file content as markdown with keyword highlighting (using the same `HighlightText` component from `docs.tsx:85`)
- Click-to-edit: clicking a section switches that section to a textarea
- Keyword highlighting works naturally in the rendered view
- This also enables markdown preview (addresses U2 from the file manager improvements)

**Recommended: Option A for quick fix, Option B in Phase 2 (file manager upgrade).**

Option A implementation sketch:

```typescript
// New: highlight overlay behind textarea
<div className="relative">
  {/* Highlight overlay — mirrors textarea content with <mark> tags */}
  {highlightTerm && (
    <div
      ref={overlayRef}
      className="absolute inset-0 pointer-events-none overflow-hidden whitespace-pre-wrap font-mono text-sm text-transparent"
      style={{ padding: textareaPadding }}
    >
      <HighlightText text={fileContent} term={highlightTerm} />
    </div>
  )}
  <textarea
    ref={editorRef}
    className="... bg-transparent"  // transparent so overlay shows through
    onScroll={() => overlayRef.current.scrollTop = editorRef.current.scrollTop}
    ...
  />
</div>
```

**B3. Search results don't include docs content**
Memory search only covers memory files (`memory/*.md`, `MEMORY.md`) and optionally session transcripts. It does not search the docs pages visible in the sidebar ("Operator1 Docs", "OpenClaw Docs"). A user searching for "Projects concept" (as in the screenshot) gets memory results but misses the comprehensive docs at `docs/operator1/projects.md` or `docs/features/projects.md`.

**Root cause:** Memory search uses QMD's index which only indexes paths configured in `memory.qmd.paths` and the agent's workspace `memory/` directory. Docs are a separate content source with their own Fuse.js search (in `docs.tsx`). The two search systems are completely disconnected.

**Fix (two approaches):**

Approach 1 — **Cross-reference in UI** (quick):

- When showing memory search results, also run a Fuse.js search against the docs index
- Show a "Related docs" section below memory results
- Clicking a doc result navigates to the docs page with keyword highlighting (existing flow)
- **No backend changes needed** — purely UI-side

Approach 2 — **Index docs in QMD** (deeper):

- Add `docs/` directory to `memory.qmd.paths` configuration
- QMD indexes docs alongside memory files
- Search results include docs with `source: "docs"` label
- Clicking navigates to the docs page (not Files tab)
- **Requires:** new source type in the search result schema, UI routing logic

**Recommended: Approach 1 for v1 (quick, no backend changes), Approach 2 as Phase 4 enhancement.**

### 2.3 UI Gaps (features the backend supports but the UI doesn't expose)

**U1. No memory scope/path configuration UI**
Backend supports `extraPaths`, `sources: ["memory", "sessions"]`, `experimental.sessionMemory`, but there's zero UI to configure these. Users must hand-edit `openclaw.json`.

**U2. Files tab is not a file manager**
No create, delete, rename, move. No tree view for `memory/` subdirectories. No markdown preview. Plain textarea editor. Limited to 10 files before "Show all" toggle.

**U3. No project memory in UI**
Project memory at `~/.openclaw/workspace/projects/{id}/memory/` is invisible. Can't view, create, or edit project-specific memory from the control panel.

**U4. No heartbeat dashboard**
No visibility into: heartbeat schedule, last run, next run, history, success/fail rate, HEARTBEAT.md editor, state JSON viewer, skip reasons.

**U5. No stale-index banner**
`MemoryProviderStatus.dirty` exists but the UI never shows "Index out of date — reindex now?"

**U6. No search filters**
Can't filter by source (memory vs sessions), date range, file path, or score threshold. Single text input only.

**U7. No embedding provider management**
Can't switch providers, test connectivity, or see cache hit rates from the UI.

### 2.4 Architectural Gaps

**A1. `agents.files.delete` RPC missing**
Can't delete files from the UI. Blocks file manager upgrade.

**A2. Activity log needs SQLite backing**
Should be a table (`op1_memory_activity`) with indexes, not raw JSONL scanning.

**A3. No memory health scoring**
No composite health score combining: index freshness, search success rate, embedding coverage, daily note recency, MEMORY.md size. Would enable "memory health: 7/10" in the dashboard.

**A4. No cross-agent memory sharing**
Agents can't read each other's memory. For the Matrix org structure, department heads should be able to search their workers' memories for status updates.

**A5. No concurrency/race condition handling for file writes**
Multiple agents (or a flush + heartbeat running concurrently) can write to the same daily note file simultaneously. There is no file locking, atomic write pattern, or append-safe mechanism. A concurrent write during flush + heartbeat distillation could corrupt or truncate a daily note.

**A6. No memory deduplication**
If context compaction triggers twice in one session (e.g., long conversation with multiple compaction boundaries), the agent may flush duplicate content to the same daily note. No dedup or idempotency mechanism exists — the flush prompt says "APPEND" unconditionally.

**A7. Search quality is unaddressed (not just frequency)**
F1 identifies low search frequency but the root cause may also be poor search quality. If search returns irrelevant results, agents learn to stop searching. No query expansion, synonym handling, result quality feedback loop, or minimum-corpus-size detection ("not enough memory to search yet — skip").

**A8. QMD failure mode is underspecified**
Historical 4000ms timeouts are noted (Section 1.2) but there is no robust fallback architecture. Phase 1B adds a timeout, but the fallback is a text message — no automatic switch to FTS5 builtin search when QMD is degraded. If QMD is down for hours, memory search is effectively disabled.

**A9. MEMORY.md 200-line ceiling**
The system truncates MEMORY.md after 200 lines when injecting into agent context. The distillation strategy (Phase 5D) proposes appending weekly summaries, which will eventually exceed this limit. Distillation must actively manage MEMORY.md size, not just append.

---

## 3. Improvement Plan — Phased Implementation

### Phase 0: Fix Search→Files Bugs

**Goal:** Fix the broken search-to-file navigation, add keyword highlighting, and cross-reference docs in search results. These are user-visible bugs that must be fixed before any new features.

#### 0A. Fix session result click (B1 — blank content pane)

- **File:** `ui-next/src/pages/memory.tsx` → `handleResultClick()` (line 982)
- **Change:** Detect session results (`result.source === "sessions"` or `result.path.startsWith("qmd/")`) and handle them differently:
  - Don't switch to Files tab — session transcripts aren't editable workspace files
  - Instead: expand the snippet inline (show more context around the match) or open a read-only modal
  - For the inline expansion: add an `expandedResultId` state to the memory store; when set, render a larger snippet area below the result card
- **Fallback:** For memory file results that fail to load (e.g. deleted file), show "File not available" in the content pane instead of blank
- **Store change:** `ui-next/src/store/memory-store.ts` — add `expandedResultId: string | null`, `setExpandedResultId()`

#### 0B. Add keyword highlighting to Files tab (B2)

- **File:** `ui-next/src/pages/memory.tsx` → Files tab `useEffect` (line 688)
- **Approach:** Textarea overlay pattern (adapted from the docs.tsx `HighlightText` component for `<textarea>`):
  1. Add `highlightTerm: string | null` to memory store (set from search query when navigating)
  2. Add a `<div>` overlay behind the textarea with identical font/padding/scroll
  3. In the overlay, render `fileContent` with `<mark>` tags wrapping matches (reuse `HighlightText` from `docs.tsx:85` or extract to shared component)
  4. Sync scroll position: `textarea.onScroll → overlay.scrollTop = textarea.scrollTop`
  5. Make textarea `bg-transparent` so the overlay marks show through
  6. Clear `highlightTerm` after 10s or on any edit (don't persist permanently)
- **Shared component:** Extract `HighlightText` from `docs.tsx` into `ui-next/src/components/ui/highlight-text.tsx` (used by both docs and memory)
- **Store change:** `ui-next/src/store/memory-store.ts` — add `highlightTerm: string | null`, `setHighlightTerm()`
- **Wire up:** In `handleResultClick()`, call `store.setHighlightTerm(store.searchQuery)` before switching tabs

#### 0C. Cross-reference docs in search results (B3)

- **File:** `ui-next/src/pages/memory.tsx` → Search tab
- **Approach (UI-only, no backend changes):**
  1. Import the docs Fuse.js index (or create a shared hook `useDocsSearch`)
  2. When memory search results render, also run Fuse search against docs with the same query
  3. Show a "Related Documentation" section below memory results with up to 3 doc matches
  4. Each doc result shows: title (highlighted), snippet (highlighted), link to docs page
  5. Clicking navigates to `/docs/operator1/<page>` or `/docs/openclaw/<page>` with `highlightTerm` set (triggers the existing `useContentHighlight` in docs.tsx)
- **Shared hook:** `ui-next/src/hooks/use-docs-search.ts` — wraps Fuse.js index; returns `searchDocs(query): DocsSearchResult[]`
- **Lazy loading:** Don't load the docs index until first memory search (avoid bundle impact)

#### 0D. Improve search result cards

- **File:** `ui-next/src/pages/memory.tsx` → Search tab result rendering
- **Changes:**
  - Highlight search terms in snippet text (use `HighlightText` component from 0B)
  - For session results: change "View in Files" link to "Expand Context" (expands snippet inline)
  - For memory results: keep "View in Files" but add tooltip "Opens in file editor with highlights"
  - Show file icon based on source: 📝 for memory, 💬 for sessions, 📖 for docs
  - Add copy-snippet button on each result card

### Phase 1: Fix Core Functional Issues

**Goal:** Make memory search faster, more reliable, and more visible. Improve write safety and search quality.

#### 1A. Strengthen mandatory recall prompt + search quality

- **File:** `src/agents/system-prompt.ts` → `buildMemorySection()`
- **Change:** Make the recall instruction more explicit and add enforcement. Current prompt says "before answering anything about prior work..." — agents interpret this loosely.
- **New prompt addition:**

```
CRITICAL: You MUST call memory_search BEFORE answering ANY question that references:
- Past conversations, decisions, or commitments
- People, dates, deadlines, or project status
- User preferences or prior feedback
- TODO items or action items
If you answer from recall without searching, your answer may be stale or wrong.
After searching, cite the source: "From memory/2026-03-10.md#L42"
```

- **Search quality improvements (addresses A7):**
  - Add a minimum corpus size check: if fewer than 3 indexed files, skip search and note "memory too sparse for useful search" in the prompt — avoids training agents that search is useless
  - Add query expansion guidance in the prompt: "Use multiple search queries with different phrasings if the first returns few results"
  - Track result usage: log whether the agent cited a search result in its response (compare memory_search results with response content). This feeds into the health score (Phase 3D).
- **Metric:** Track `memory_search` call count per session in activity log. Target: 2x current rate.

#### 1B. Add search timeout + QMD fallback to memory tool

- **File:** `src/agents/tools/memory-tool.ts`
- **Change:** Wrap the search call with a timeout (default 8s). If search times out, return a fallback message: "Memory search timed out. Answering from context only."
- **Why:** Prevents 46s blocking of agent turns.
- **QMD degraded-mode fallback (addresses A8):** If QMD times out or errors 3 times in a row within a session, automatically switch to FTS5 builtin search for the remainder of that session. Log the switch as a `memory.provider.fallback` event. Reset on next session start. This ensures memory search remains functional even when QMD is down for extended periods.

#### 1C. Add stale-index detection + auto-reindex

- **File:** `src/gateway/server-methods/memory-dashboard.ts`
- **Change:** If `memory.status` returns `dirty: true`, the UI should show a banner. Additionally, if the index hasn't been updated in 2x the configured interval, auto-trigger a background reindex.
- **UI file:** `ui-next/src/pages/memory.tsx` → Index Status tab, add yellow banner.

#### 1D. Add memory flush logging + dedup + safe writes

- **File:** `src/auto-reply/reply/memory-flush.ts`
- **Change:** After flush turn completes, log what was written:
  - If agent wrote to a file: log path + bytes written
  - If agent returned `░`: log "flush skipped — nothing to store"
  - Store flush events in `core_settings` (scope: `memory.flush.log`, key: timestamp)
- **Purpose:** Makes flush visible for debugging. Currently it's completely silent.
- **Dedup (addresses A6):** Before appending to the daily note, hash the new content and compare against the last N entries in the file. If >80% similarity (simple line-overlap check), skip the append and log "flush skipped — duplicate content". This prevents repeated compaction cycles from writing the same information multiple times.
- **Safe writes (addresses A5):** Use atomic write pattern for daily note appends: write to `memory/YYYY-MM-DD.md.tmp`, then rename. For concurrent access, use `fs.appendFile` with `O_APPEND` flag (atomic on POSIX for reasonable sizes) rather than read-modify-write. This prevents corruption when flush and heartbeat distillation run concurrently.

#### 1E. Add daily note retention policy

- **New file:** `src/memory/daily-note-retention.ts`
- **Logic:**
  - Default: keep 30 days of daily notes
  - Reuse existing `MemoryQmdSessionConfig.retentionDays` field (`src/config/types.memory.ts:48`) — extend its scope to cover daily note files in addition to session exports, or add a sibling `memory.dailyNotes.retentionDays` field if the semantics need to differ
  - On reindex: scan `memory/` for `YYYY-MM-DD.md` files older than threshold
  - Don't delete — move to `memory/.archive/` (recoverable)
  - Add a heartbeat task to distill archived notes into MEMORY.md before archiving
- **Indexer exclusion:** Ensure QMD and builtin indexers skip `memory/.archive/` and `memory/.history/` directories (glob exclude pattern: `!memory/.archive/**`, `!memory/.history/**`). If QMD auto-discovers files in these paths, archived notes will pollute search results.
- **Config:** Extend `MemoryQmdSessionConfig` or add `MemoryDailyNoteConfig` in `src/config/types.memory.ts` — do NOT create a parallel `retention` section that duplicates the existing `retentionDays` field

### Phase 2: UI File Manager + Scope Config

**Goal:** Transform the Files tab into a proper file manager and expose scope configuration.

#### 2A. Add `agents.files.delete` RPC

- **File:** `src/gateway/server-methods/agents.ts`
- **New handler:** `"agents.files.delete"` — deletes a file from agent workspace
  - Validate path is within workspace root (no traversal)
  - Reject deletion of required files (SOUL.md, AGENTS.md, IDENTITY.md)
  - Allow deletion of memory files and optional files
- **Register:** Add to `server-methods-list.ts` (`BASE_METHODS`), `method-scopes.ts` (ADMIN scope)

#### 2B. Add `agents.files.create` RPC

- **File:** `src/gateway/server-methods/agents.ts`
- **New handler:** `"agents.files.create"` — creates a new file in agent workspace
  - Validate name matches `^[a-zA-Z0-9._-]+$` or is a path like `memory/custom-note.md`
  - Create parent directories if needed
  - Reject if file already exists (use `agents.files.set` to overwrite)
- **Register:** Add to `server-methods-list.ts`, `method-scopes.ts` (ADMIN scope)

#### 2C. Upgrade Files tab to file manager

- **File:** `ui-next/src/pages/memory.tsx` → `FilesTab`
- **Changes:**
  - **Tree view** for `memory/` directory (collapsible, shows subdirs)
  - **"New File" button** → modal with name input, creates via `agents.files.create`
  - **"Delete" button** per file → confirmation dialog, calls `agents.files.delete`
  - **"Rename"** → copy content to new name + delete old (no native rename RPC needed)
  - **File metadata** in list: size, last modified, line count
  - **Markdown preview** toggle (split pane, right side)
  - **Cmd+S** save shortcut in editor
  - **Unsaved changes** diff view (show what changed since last save)
  - **Drag-and-drop** reordering within memory/ (stretch goal)

#### 2D. Add scope configuration section

- **File:** `ui-next/src/pages/memory.tsx` → new section in Index Status tab (or 5th "Settings" tab)
- **Shows:**
  - List of currently indexed paths (from `memory.status` → `extraPaths`)
  - "Add Path" button → folder picker or manual entry with existence check via `onboarding.validatePath`-style RPC
  - "Remove Path" button per entry
  - Toggle: "Index session transcripts" (`experimental.sessionMemory`)
  - Toggle: "Enable session memory" (`sources` array toggle)
- **Backend:** All changes go through `config.patch` RPC to update `memory.qmd.paths` or `agents.defaults.memorySearch.sources`

#### 2E. Add project memory management

- **File:** `ui-next/src/pages/memory.tsx` → Files tab, new "Project Memory" section
- **Shows:**
  - List of projects with memory dirs (from `projects.list` RPC)
  - Per-project: file list, editor, create/delete
  - Badge showing which projects are in the current agent's search scope
- **Backend:** Reuse `agents.files.list/get/set` with a project path parameter, or add new RPCs for project-scoped file operations

### Phase 3: Heartbeat Dashboard + Memory Analytics

**Goal:** Make heartbeat visible and add memory health insights.

#### 3A. Heartbeat dashboard page

- **New file:** `ui-next/src/pages/heartbeat.tsx`
- **New hook:** `ui-next/src/hooks/use-heartbeat.ts`
- **Sidebar entry:** Icon `HeartPulse`, URL `/heartbeat`, subtitle "Heartbeat schedule and history"
- **Sections:**

  **Schedule panel:**
  - Current interval (from config)
  - Last run time + duration + status
  - Next scheduled run
  - Enable/disable toggle (calls `set-heartbeats` RPC)
  - Active hours display (if configured)

  **History panel:**
  - Table of recent heartbeat events (from `last-heartbeat` RPC — but this only returns the last one)
  - **Backend gap:** Need a `heartbeat.history` RPC that returns the last N events
  - Columns: timestamp, status (sent/ok-empty/ok-token/skipped/failed), reason, duration, preview

  **HEARTBEAT.md editor:**
  - Inline editor for HEARTBEAT.md (reuse file editor component from Files tab)
  - Preview of what tasks the heartbeat will check
  - "Run Now" button (triggers `requestHeartbeatNow` — needs new RPC)

  **State viewer:**
  - Display `memory/heartbeat-state.json` contents
  - Show last check times for each task
  - Visual: green/yellow/red indicators based on staleness

#### 3B. Add heartbeat history RPC

- **File:** `src/gateway/server-methods/system.ts`
- **New handler:** `"heartbeat.history"` — returns last N heartbeat events
- **Implementation:** Store heartbeat events in `core_settings` (scope: `heartbeat.event`, key: timestamp) or a dedicated table
- **Register:** Add to `server-methods-list.ts`, `method-scopes.ts` (READ scope)

#### 3C. Add "heartbeat.runNow" RPC

- **File:** `src/gateway/server-methods/system.ts`
- **New handler:** `"heartbeat.runNow"` — triggers immediate heartbeat
- **Implementation:** Call `requestHeartbeatNow({ reason: "manual-ui" })`
- **Register:** Add to `server-methods-list.ts`, `method-scopes.ts` (WRITE scope)

#### 3D. Memory health score

- **New file:** `src/memory/health-score.ts`
- **Composite score (0–10) based on:**
  - Index freshness: when was last reindex? (stale → penalty)
  - Search success rate: % of searches returning results (from activity log)
  - Embedding coverage: % of chunks with embeddings vs FTS-only
  - MEMORY.md recency: when was it last updated?
  - Daily note recency: has a daily note been written today?
  - Memory size: is it growing or stagnant?
- **UI:** Show as a health gauge in Index Status tab header
- **RPC:** Extend `memory.status` response with `healthScore: number`

#### 3E. Memory analytics cards

- **File:** `ui-next/src/pages/memory.tsx` → Index Status tab, new "Insights" section
- **Cards:**
  - **Search patterns:** Top 5 most-queried terms (aggregated from activity)
  - **Memory growth:** File count + total size over last 30 days (chart)
  - **Dead files:** Files indexed but never searched (candidates for cleanup)
  - **Flush history:** Recent memory flushes with what was written
  - **Agent memory distribution:** Bar chart of memory size per agent

### Phase 4: Search Improvements + Activity Performance

**Goal:** Make search more powerful and fix the activity log performance bottleneck.

#### 4A. Add search filters to UI

- **File:** `ui-next/src/pages/memory.tsx` → Search tab
- **New controls above results:**
  - Source toggle: Memory / Sessions / Both
  - Date range picker (after/before)
  - Min score slider (0.1 to 0.9, default 0.35)
  - Path filter text input (glob pattern)
  - Sort by: Relevance / Date / File
- **Backend:** Extend `memory.search` RPC params:
  ```typescript
  {
    query: string;
    maxResults?: number;
    minScore?: number;
    source?: "memory" | "sessions";  // NEW
    pathGlob?: string;               // NEW
    afterDate?: number;              // NEW (unix ms)
    beforeDate?: number;             // NEW (unix ms)
    sortBy?: "relevance" | "date";   // NEW
  }
  ```
- **File:** `src/gateway/server-methods/memory-dashboard.ts` → pass filters through to search manager

#### 4B. SQLite-backed activity log

- **New migration (v12)** in `src/infra/state-db/schema.ts`:
  ```sql
  CREATE TABLE IF NOT EXISTS op1_memory_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    operation TEXT NOT NULL,          -- search, read, write, edit
    tool_name TEXT,
    file_path TEXT,
    query TEXT,
    snippet TEXT,
    session_key TEXT,
    session_file TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
  CREATE INDEX IF NOT EXISTS idx_op1_memory_activity_agent ON op1_memory_activity(agent_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_op1_memory_activity_op ON op1_memory_activity(operation);
  ```
- **New file:** `src/infra/state-db/memory-activity-sqlite.ts` (follow `commands-sqlite.ts` pattern)
- **Incremental scanner:** Track last-scanned byte offset per session file in `core_settings`. Only scan new bytes on each call.
- **Backfill (lazy):** Do NOT scan all sessions on first run — this blocks startup for agents with many sessions (main has 31+). Instead, backfill in a background task after migration: scan one session file per tick (100ms interval), yielding to gateway requests. New activity is written to SQLite immediately; the Activity tab shows "Backfill in progress (42%)" until complete.
- **UI benefit:** Activity tab loads from SQLite (instant) instead of scanning JSONL (slow).

#### 4C. Activity log date filter + search

- **File:** `ui-next/src/pages/memory.tsx` → Activity tab
- **New controls:**
  - Date range picker
  - Search within activity (filter by query text or file path)
  - Operation type checkboxes (search, read, write, edit)
- **Backend:** Add filter params to `memory.activity` RPC

### Phase 5: Advanced Features

**Goal:** Cross-agent memory, import/export, versioning.

#### 5A. Memory import/export

- **UI:** Add "Export All" and "Import" buttons to Files tab header
- **Export:** Downloads zip of all `memory/` + `MEMORY.md` files
- **Import:** Upload `.md` files → writes to `memory/` via `agents.files.set`
- **Backend:** New `"agents.files.export"` RPC that returns a zip buffer, or handle client-side by fetching all files and zipping in browser (simpler)

#### 5B. Memory versioning (lightweight)

- **On every `agents.files.set` write:** backup the previous version to `memory/.history/{filename}.{timestamp}.md`
- **UI:** "History" dropdown per file in the editor → shows restore points
- **Retention:** Keep last 10 versions per file, auto-prune older ones
- **Backend:** Add to `agents.files.set` handler in `src/gateway/server-methods/agents.ts`

#### 5C. Cross-agent memory search (read-only)

- **New RPC:** `"memory.search.cross"` — searches across multiple agents' memories
- **Params:** `{ query, agentIds?: string[], maxResults? }`
- **Security model (addresses A4 concerns):**
  - Only ADMIN scope can search across agents
  - **Audit logging:** Every cross-agent search is logged with: caller agent ID, target agent IDs, query, timestamp, result count. Stored in `op1_memory_activity` with `operation: "cross-search"`.
  - **Per-agent opt-out:** Each agent can set `memory.crossSearchVisible: false` in its config to exclude itself from cross-agent search results. Default: `true` for worker agents, `false` for agents handling sensitive user data.
  - **Content filtering:** Strip lines matching sensitive patterns (tokens, keys, passwords) from cross-agent results before returning. Use the same sanitization as the existing credential scrubber.
- **Use case:** Department heads reviewing workers' notes, Operator1 searching all agent memories for a topic
- **UI:** Add "Search all agents" toggle to Search tab (ADMIN only)

#### 5D. Heartbeat-driven memory distillation

- **Enhance HEARTBEAT.md template** with a structured distillation task:

  ```markdown
  ### Memory Distillation (weekly)

  - Read memory/\*.md files from the last 7 days
  - Extract key decisions, commitments, and learnings
  - UPDATE (not just append) MEMORY.md — merge new insights into existing sections
  - Archive processed daily notes to memory/.archive/
  - CRITICAL: MEMORY.md must stay under 180 lines (system truncates at 200)
  ```

- **MEMORY.md size management (addresses A9):** The system truncates MEMORY.md after 200 lines when injecting into agent context. Distillation must:
  - Target 180 lines max (20-line safety margin)
  - Merge new content into existing sections rather than appending new sections endlessly
  - When approaching the limit: summarize/compress older entries, move detailed content to `memory/archive-YYYY-QN.md` (quarterly archive files that remain searchable via QMD but aren't injected into context)
  - Add a heartbeat check: if MEMORY.md exceeds 180 lines, flag it as "needs compaction" in `heartbeat-state.json`
- **Enforcement:** Add a heartbeat check that flags if MEMORY.md hasn't been updated in 7+ days
- **State tracking:** `heartbeat-state.json` → `lastDistillation` timestamp, `memoryMdLineCount` gauge

#### 5E. Memory health alerts

- **If health score drops below threshold (default: 4/10):**
  - Emit a `memory.health.degraded` gateway event
  - Show banner in UI: "Memory health is degraded — [View Details]"
  - Optionally notify via heartbeat channel
- **Auto-remediation suggestions:**
  - "Index is stale — click to reindex"
  - "No daily notes in 5 days — memory may be incomplete"
  - "MEMORY.md is empty — consider distilling daily notes"

---

## 4. Backend Changes Summary

### New RPCs

| Method                | Scope | Phase | Purpose                     |
| --------------------- | ----- | ----- | --------------------------- |
| `agents.files.delete` | ADMIN | 2A    | Delete workspace file       |
| `agents.files.create` | ADMIN | 2B    | Create new workspace file   |
| `heartbeat.history`   | READ  | 3B    | Last N heartbeat events     |
| `heartbeat.runNow`    | WRITE | 3C    | Trigger immediate heartbeat |
| `memory.search.cross` | ADMIN | 5C    | Cross-agent memory search   |

### Modified RPCs

| Method            | Phase | Change                                                                 |
| ----------------- | ----- | ---------------------------------------------------------------------- |
| `memory.status`   | 3D    | Add `healthScore` to response                                          |
| `memory.search`   | 4A    | Add `source`, `pathGlob`, `afterDate`, `beforeDate`, `sortBy` params   |
| `memory.activity` | 4B    | Read from SQLite instead of scanning JSONL; add date/operation filters |

### New SQLite Migrations

| Version | Phase | Table                                             |
| ------- | ----- | ------------------------------------------------- |
| v12     | 4B    | `op1_memory_activity` — activity log with indexes |

### New Files

| Path                                           | Phase | Purpose                                                      |
| ---------------------------------------------- | ----- | ------------------------------------------------------------ |
| `ui-next/src/components/ui/highlight-text.tsx` | 0B    | Shared keyword highlight component (extracted from docs.tsx) |
| `ui-next/src/hooks/use-docs-search.ts`         | 0C    | Shared Fuse.js docs search hook                              |
| `src/memory/daily-note-retention.ts`           | 1E    | Retention policy for daily notes                             |
| `src/memory/health-score.ts`                   | 3D    | Composite health score calculation                           |
| `src/infra/state-db/memory-activity-sqlite.ts` | 4B    | SQLite adapter for activity log                              |
| `ui-next/src/pages/heartbeat.tsx`              | 3A    | Heartbeat dashboard page                                     |
| `ui-next/src/hooks/use-heartbeat.ts`           | 3A    | Heartbeat state hook                                         |

### Modified Files

| Path                                             | Phase                      | Change                                                                                                    |
| ------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/agents/system-prompt.ts`                    | 1A                         | Strengthen mandatory recall prompt                                                                        |
| `src/agents/tools/memory-tool.ts`                | 1B                         | Add search timeout + QMD degraded-mode fallback                                                           |
| `src/auto-reply/reply/memory-flush.ts`           | 1D                         | Add flush logging + dedup + atomic writes                                                                 |
| `src/config/types.memory.ts`                     | 1E                         | Extend `MemoryQmdSessionConfig` or add `MemoryDailyNoteConfig` (reuse existing `retentionDays` semantics) |
| `src/gateway/server-methods/agents.ts`           | 2A/2B                      | Add delete/create handlers                                                                                |
| `src/gateway/server-methods/system.ts`           | 3B/3C                      | Add heartbeat.history/runNow                                                                              |
| `src/gateway/server-methods/memory-dashboard.ts` | 4A                         | Add search filter params                                                                                  |
| `src/gateway/server-methods-list.ts`             | 2A/2B/3B/3C/5C             | Register new methods                                                                                      |
| `src/gateway/method-scopes.ts`                   | 2A/2B/3B/3C/5C             | Scope new methods                                                                                         |
| `src/infra/state-db/schema.ts`                   | 4B                         | Add migration v12                                                                                         |
| `ui-next/src/pages/memory.tsx`                   | 0A-0D/1C/2C/2D/2E/3E/4A/4C | Search→Files fix, keyword highlighting, docs cross-ref, major UI upgrades                                 |
| `ui-next/src/pages/docs.tsx`                     | 0B                         | Extract `HighlightText` to shared component                                                               |
| `ui-next/src/hooks/use-memory.ts`                | 2C/4A/4C                   | Add new RPC wrappers                                                                                      |
| `ui-next/src/store/memory-store.ts`              | 0A/0B/2C/3E/4C             | Add `expandedResultId`, `highlightTerm`, new state sections                                               |
| `ui-next/src/components/app-sidebar.tsx`         | 3A                         | Add heartbeat sidebar entry                                                                               |

---

## 5. UI Wireframes

### 5.1 Files Tab — Upgraded File Manager

```
┌─────────────────────────────────┬──────────────────────────────────────────┐
│  Agent: [Operator1 (COO) ▼]    │  MEMORY.md                    [Preview] │
│                                 │  ──────────────────────────────────────  │
│  [+ New File]  [Import]  [🔄]  │  1 │ # Long-Term Memory                 │
│                                 │  2 │                                     │
│  ▾ Memory Files (12)            │  3 │ ## People                           │
│    📌 MEMORY.md      4.2 KB    │  4 │ - Rohit: operator, prefers terse    │
│    📝 2026-03-13.md  1.1 KB    │  5 │ - Neo: CTO agent, handles eng      │
│    📝 2026-03-12.md  892 B     │  6 │                                     │
│    📝 2026-03-11.md  1.5 KB    │  7 │ ## Decisions                        │
│    ...                          │  8 │ - 2026-03-06: SQLite migration      │
│                                 │  9 │   complete (v1-v11)                 │
│  ▾ Identity Files (5)           │ 10 │ - 2026-03-12: Slash commands landed │
│    SOUL.md           2.1 KB    │    │                                     │
│    AGENTS.md         3.8 KB    │ ──────────────────────────────────────── │
│    IDENTITY.md       512 B     │  [Save] [Revert] [History ▼] [Delete]   │
│    TOOLS.md          1.3 KB    │  ● Unsaved changes (3 lines modified)   │
│    USER.md           256 B     │                                          │
│                                 │                                          │
│  ▾ Project Memory               │                                          │
│    📁 operator1 (3 files)       │                                          │
│    📁 webapp (1 file)           │                                          │
└─────────────────────────────────┴──────────────────────────────────────────┘
```

### 5.2 Heartbeat Dashboard

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Heartbeat                                                [Enabled ●]    │
│                                                                           │
│  ┌─────────────────────────┐  ┌────────────────────────────────────────┐ │
│  │  Schedule               │  │  HEARTBEAT.md                          │ │
│  │                         │  │  ─────────────────────────────────────  │ │
│  │  Interval: 30m          │  │  ## Checks (pick 1-2 per heartbeat)   │ │
│  │  Last run: 14:40 (3m)   │  │                                        │ │
│  │  Next run: 15:10        │  │  ### QMD Keepalive (EVERY heartbeat)   │ │
│  │  Status: ● ok-empty     │  │  - Run: memory_search with any query  │ │
│  │                         │  │  - Verify: provider: "qmd" in resp    │ │
│  │  Active hours: all day  │  │                                        │ │
│  │                         │  │  ### Memory Maintenance (weekly)       │ │
│  │  [Run Now]              │  │  - Distill daily notes → MEMORY.md    │ │
│  └─────────────────────────┘  └────────────────────────────────────────┘ │
│                                                                           │
│  ┌─ Recent History ──────────────────────────────────────────────────┐   │
│  │ Time       Status     Reason    Duration  Preview                 │   │
│  │ 14:40      ok-empty   interval  3.2s      —                       │   │
│  │ 14:10      ok-empty   interval  2.8s      —                       │   │
│  │ 13:40      sent       interval  4.1s      "QMD keepalive OK..."   │   │
│  │ 13:10      ok-empty   interval  2.5s      —                       │   │
│  │ 12:40      sent       cron      6.3s      "Memory maintenance..." │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ┌─ State (heartbeat-state.json) ────────────────────────────────────┐  │
│  │ qmd_keepalive:       2026-03-13 14:40  ● fresh                    │  │
│  │ memory_maintenance:  2026-03-13 12:40  ● fresh                    │  │
│  │ cross_dept_sync:     2026-03-10 03:00  ⚠ 3 days ago              │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

### 5.3 Search Tab — With Filters

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Search Memory                                    Backend: QMD (hybrid)  │
│                                                                           │
│  [What decisions were made about SQLite migration?          ] [Search]   │
│                                                                           │
│  Source: [● Memory] [○ Sessions] [○ Both]    Score ≥ [0.35 ───●──]     │
│  Date: [After: ________] [Before: ________]  Sort: [Relevance ▼]       │
│  Path: [memory/*.md                        ]                             │
│                                                                           │
│  ── 6 results (2.3s, 12 files indexed) ──────────────────────────────── │
│                                                                           │
│  📄 memory/2026-03-06.md  L42-L58  Score: 0.89  ● memory  Mar 6       │
│  │ "Decision: migrate all JSON state to SQLite operator1.db. Phase 0    │
│  │  tables: sessions, delivery queue, teams. Migration runner is         │
│  │  idempotent — safe to run on every startup..."                        │
│  │                                                            [Open →]  │
│  ...                                                                     │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Implementation Timeline

| Phase | Work                                                                                   | Dependencies                                                              |
| ----- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **0** | Fix Search→Files bugs: session result click, keyword highlighting, docs cross-ref      | **Decide Q5 (editor choice) before 0B**                                   |
| **1** | Fix core issues (prompt, timeout+fallback, flush logging+dedup+safe writes, retention) | **Verify Q7 (indexer dotfile behavior) before 1E**                        |
| **2** | UI file manager + scope config + project memory                                        | Phase 0 (HighlightText component), 2A/2B RPCs must land before 2C UI work |
| **3** | Heartbeat dashboard + memory analytics + health score                                  | None (parallel with Phase 2)                                              |
| **4** | Search filters + SQLite activity log                                                   | Phase 1 (flush logging feeds activity data)                               |
| **5** | Import/export, versioning, cross-agent search, distillation                            | Phases 1–4, **measure bundle size (Q8) before adding new pages**          |

**Execution order:** Phase 0 → Phase 1 → (Phase 2 + Phase 3 in parallel) → Phase 4 → Phase 5

### Success Metrics per Phase

| Phase | Metric                                             | Target                                      |
| ----- | -------------------------------------------------- | ------------------------------------------- |
| **0** | Search→Files click produces visible content        | 100% (binary — bug fix)                     |
| **0** | Keyword highlighting visible after search→file nav | 100%                                        |
| **1** | `memory.search` calls per day                      | 20+ (2.5x current 8/day)                    |
| **1** | P99 search latency                                 | < 10s (down from 46s)                       |
| **1** | Memory flush events logged                         | 100% of flushes (currently 0%)              |
| **2** | File CRUD operations via UI                        | All 4 operations functional                 |
| **3** | Memory health score available                      | Computed on every `memory.status` call      |
| **3** | Heartbeat history depth                            | Last 100 events queryable                   |
| **4** | Activity tab load time                             | < 200ms (down from multi-second JSONL scan) |
| **4** | Search with filters returns results                | Filters correctly narrow results            |
| **5** | MEMORY.md stays under 180 lines                    | Enforced by heartbeat check                 |

---

## 7. Testing Plan

Each phase must include tests before merging. The repo requires 70% coverage (lines/branches/functions/statements).

### Phase 0 Tests

- `ui-next/src/pages/memory.test.tsx` — test `handleResultClick` for session vs memory results, verify expandedResultId is set for session paths, verify Files tab loads for memory paths
- `ui-next/src/components/ui/highlight-text.test.tsx` — test keyword highlighting with various inputs (multi-word, regex special chars, empty query)

### Phase 1 Tests

- `src/agents/tools/memory-tool.test.ts` — test search timeout behavior (mock slow search, verify timeout fires at 8s, verify fallback message). Test QMD fallback after 3 consecutive failures.
- `src/auto-reply/reply/memory-flush.test.ts` — test flush logging (verify events written to core_settings). Test dedup logic (duplicate content → skip). Test atomic write (concurrent appends don't corrupt).
- `src/memory/daily-note-retention.test.ts` — test retention policy (files older than threshold moved to `.archive/`, files within threshold untouched, required files never archived)

### Phase 2 Tests

- `src/gateway/server-methods/agents.test.ts` — test `agents.files.delete` (happy path, path traversal rejection, required file rejection), test `agents.files.create` (happy path, existing file rejection, invalid name rejection)

### Phase 3 Tests

- `src/gateway/server-methods/system.test.ts` — test `heartbeat.history` (returns last N events, empty history), test `heartbeat.runNow` (triggers heartbeat, returns status)
- `src/memory/health-score.test.ts` — test composite score calculation (all-healthy → 10, all-degraded → 0, partial degradation → proportional score)

### Phase 4 Tests

- `src/infra/state-db/memory-activity-sqlite.test.ts` — follow `commands-sqlite.test.ts` pattern with in-memory `:memory:` DB. Test insert, query with filters, incremental scan offset tracking, backfill idempotency.
- Schema migration test: verify v12 migration creates table and indexes, verify idempotency (running twice doesn't error)

### Phase 5 Tests

- `src/gateway/server-methods/memory-dashboard.test.ts` — test `memory.search.cross` (ADMIN-only scope, audit logging, opt-out agents excluded, content sanitization)

---

## 8. Rollback Strategy

Each phase should be reversible without data loss.

| Phase     | Rollback Approach                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0**     | Pure UI changes — revert commits, no data impact                                                                                                                                                       |
| **1A**    | Revert prompt changes in `system-prompt.ts` — no persistent state                                                                                                                                      |
| **1B**    | Remove timeout wrapper — search reverts to unbounded (degraded but functional)                                                                                                                         |
| **1D**    | Stop writing flush logs — existing logs in `core_settings` are inert                                                                                                                                   |
| **1E**    | Stop archiving — `.archive/` files remain accessible, move them back to `memory/` if needed                                                                                                            |
| **2A/2B** | Remove RPC handlers — UI file manager buttons become no-ops, fallback to existing Files tab                                                                                                            |
| **3**     | Remove heartbeat dashboard page — heartbeat continues running via existing infra                                                                                                                       |
| **4B**    | If SQLite activity table is corrupt: drop table, revert `memory.activity` RPC to JSONL scanning. Data can be re-backfilled. **Note:** this is the riskiest migration — test thoroughly before landing. |
| **5C**    | Remove cross-agent RPC — agents revert to isolated memory                                                                                                                                              |
| **5D**    | Revert HEARTBEAT.md template — manual distillation continues working                                                                                                                                   |

---

## 9. Open Questions

| #   | Question                                                   | Options                                                | Recommendation                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ---------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Daily note retention: archive or delete?                   | Archive to `.archive/` / Hard delete                   | **Archive** — recoverable, no data loss                                                                                                                                                                                                                                                                                                                                                                                  |
| 2   | Memory health score: where to compute?                     | Gateway (on status call) / Background job              | **On status call** — computed from cached stats, cheap                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | Cross-agent search: scope?                                 | All agents / Same department only                      | **Same department** for workers, **all** for Operator1/department heads                                                                                                                                                                                                                                                                                                                                                  |
| 4   | Heartbeat history: how many events to keep?                | 50 / 100 / unlimited                                   | **100** with auto-prune of older events                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | File editor: CodeMirror or keep textarea?                  | CodeMirror / Monaco / Plain textarea                   | **Decide before Phase 0B.** If CodeMirror is chosen, the textarea overlay pattern (Phase 0B) is unnecessary — CodeMirror has native search highlighting. If textarea, implement the overlay. Deferring this decision risks wasted work in Phase 0B that gets thrown away in Phase 2C. **Recommendation: Plain textarea for now** — CodeMirror adds ~150KB gzipped; revisit only if editing experience complaints emerge. |
| 6   | Activity log backfill: scan on first load or lazy?         | Eager (migrate all on upgrade) / Lazy (scan on demand) | **Lazy** — backfill in background after migration, don't block startup                                                                                                                                                                                                                                                                                                                                                   |
| 7   | Do QMD/builtin indexers auto-discover dotfile directories? | Test with `.archive/` and `.history/` dirs present     | **Must verify before Phase 1E.** If indexers pick up `.archive/` contents, archived notes pollute search results. Add glob exclusions (`!.archive/**`, `!.history/**`) to indexer config if needed.                                                                                                                                                                                                                      |
| 8   | Bundle size budget for new pages/hooks?                    | Measure after Phase 0 + Phase 3                        | **Measure incrementally.** Phase 0 adds `HighlightText` (small) + Fuse.js lazy-loaded (OK). Phase 3 adds a full page (`heartbeat.tsx`) + hook. Run `pnpm build` and compare bundle size before/after each phase. Set a ceiling (e.g., +50KB gzipped max per phase).                                                                                                                                                      |

---

## 10. References

- Memory backend config: `src/memory/backend-config.ts`
- Memory config schema: `src/config/types.memory.ts`
- Memory RPC handlers: `src/gateway/server-methods/memory-dashboard.ts`
- Memory tools: `src/agents/tools/memory-tool.ts`
- System prompt memory section: `src/agents/system-prompt.ts` → `buildMemorySection()`
- Memory flush: `src/auto-reply/reply/memory-flush.ts`
- Heartbeat runner: `src/infra/heartbeat-runner.ts`
- Heartbeat wake queue: `src/infra/heartbeat-wake.ts`
- UI memory page: `ui-next/src/pages/memory.tsx`
- UI memory store: `ui-next/src/store/memory-store.ts`
- UI memory hook: `ui-next/src/hooks/use-memory.ts`
- Memory architecture docs: `docs/operator1/memory-system.md`
- Current state-db schema: `src/infra/state-db/schema.ts` (v1–v11 applied, next available: v12)

---

_Document created by Operator1 (COO) — OpenClaw Matrix_
