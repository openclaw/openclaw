# Memory Leak Investigation Findings (codex - sessions)

Scope investigated:

- `src/config/sessions/`
- `src/agents/pi-embedded-runner/`
- `src/agents/compaction.ts` + compaction call paths
- `src/agents/workspace.ts`
- `src/agents/bootstrap-cache.ts`
- Also verified relevant dependency behavior in `@mariozechner/pi-coding-agent` (used by OpenClaw compaction/session runtime)

## Executive summary

The strongest unbounded-growth issue is **compaction being append-only**: summaries are added, but original transcript entries remain in the session tree/file forever. This means session files grow indefinitely, and each run re-loads the full historical tree into memory before building a reduced context.

Second-order growth risks are process-level Maps without true eviction (`workspaceFileCache`, bootstrap snapshot cache, session manager prewarm cache). These are smaller than transcript growth but still unbounded across enough unique session keys/files.

---

## 1) Compaction does not discard original transcript entries (high impact)

### Evidence

- OpenClaw compaction path delegates to SDK compaction:
  - `src/agents/pi-embedded-runner/compact.ts:794-796` (`session.compact(...)`)
  - `src/agents/pi-embedded-runner/run.ts:1030-1037` (overflow-triggered `contextEngine.compact(...)`)
- In `pi-coding-agent`, compaction appends a compaction entry and replaces active message context, but **does not prune old entries**:
  - `node_modules/.pnpm/@mariozechner+pi-coding-agent@0.57.1_ws@8.19.0_zod@4.3.6/node_modules/@mariozechner/pi-coding-agent/dist/core/agent-session.js:1277-1280`
    - `appendCompaction(...)`
    - then `buildSessionContext()` + `agent.replaceMessages(...)`
- `SessionManager` is append-only and keeps all entries in memory in `fileEntries`/`byId`:
  - `.../dist/core/session-manager.js:434-436` (in-memory stores)
  - `.../dist/core/session-manager.js:563-567` (`_appendEntry` pushes into arrays/maps)
  - `.../dist/core/session-manager.js:610-624` (`appendCompaction` just appends)
- On every run, OpenClaw opens session and therefore loads full entry history:
  - `src/agents/pi-embedded-runner/run/attempt.ts:1087` (`SessionManager.open(...)`)

### Why this can explain runaway memory

Even when context is "compacted" for prompt usage, old entries are retained in session files and loaded again next run. With 1M-context usage across many sessions, retained historical entries and repeated deserialization can drive sustained RSS growth.

### Proposed fix

- Add a real transcript compaction mode that rewrites session history (not just appends compaction marker), or periodic archival/truncation of pre-compaction segments.
- At minimum, add a cap on retained historical entries per session (entry count or byte-size based) and rewrite session file accordingly.

### Diagnostic to confirm

- Track session file growth over time for active channels:
  - `find ~/.openclaw -path "*sessions/*.jsonl" -type f -print0 | xargs -0 ls -lh | sort -k5 -h | tail -n 30`
- Compare largest files with RSS trend and run frequency.

---

## 2) `workspaceFileCache` has no eviction (medium impact)

### Evidence

- Global cache map:
  - `src/agents/workspace.ts:43`
- Writes on successful reads:
  - `src/agents/workspace.ts:80`
- Only per-path deletes on read failures:
  - `src/agents/workspace.ts:67`, `src/agents/workspace.ts:83`
- No TTL/LRU/max-size/clear API found in file.

### Why it matters

The cache stores full file contents (`content: string`) keyed by file path. Across many unique workspace paths/extra bootstrap files, memory usage monotonically increases.

### Proposed fix

- Add LRU + max entries (or max total bytes) + TTL.
- Add explicit invalidation on session/workspace rollover.

### Diagnostic

- Add temporary metric/log of `workspaceFileCache.size` and approximate bytes to correlate with RSS.

---

## 3) Bootstrap snapshot cache (`src/agents/bootstrap-cache.ts`) is unbounded by key count (medium impact)

### Evidence

- Global cache:
  - `src/agents/bootstrap-cache.ts:3`
- Insert per `sessionKey`:
  - `src/agents/bootstrap-cache.ts:15`
- Deletes only on explicit clear/rollover/all-clear:
  - `src/agents/bootstrap-cache.ts:19-21`, `23-35`

### Why it matters

Values are arrays of bootstrap files (with `content`), so each new unique session key retains another copy. For long-lived multi-channel installs with many transient keys (thread/topic variants), this can accumulate.

### Proposed fix

- Add TTL/LRU bounds.
- Normalize cache key strategy (e.g., parent session key for thread variants if safe).

### Diagnostic

- Instrument `cache.size` and total content bytes in this module.

---

## 4) Session-manager prewarm cache keeps expired entries forever (low/medium impact)

### Evidence

- Global map:
  - `src/agents/pi-embedded-runner/session-manager-cache.ts:10`
- `isSessionManagerCached` checks TTL but does not delete expired map entries:
  - `src/agents/pi-embedded-runner/session-manager-cache.ts:35-46`
- New files add new entries:
  - `src/agents/pi-embedded-runner/session-manager-cache.ts:24-33`

### Why it matters

Each unique session file path leaves a resident map entry. Individual entries are small, but count is unbounded over process lifetime.

### Proposed fix

- Delete expired entries in `isSessionManagerCached`.
- Add periodic sweep or max-entry bound.

---

## 5) Session store maintenance defaults to `warn`, so entry count is not enforced by default (medium impact)

### Evidence

- Default mode is `warn`:
  - `src/config/sessions/store-maintenance.ts:15`
- Resolved default mode:
  - `src/config/sessions/store-maintenance.ts:140`
- In `warn` mode, prune/cap are skipped (warn-only path):
  - `src/config/sessions/store.ts:353-389`
- In enforce mode only, pruning/capping happen:
  - `src/config/sessions/store.ts:390-453`

### Why it matters

If many session keys accumulate, session metadata object can grow indefinitely. Less likely to explain GB-scale growth alone, but contributes background growth.

### Proposed fix

- For gateway workloads, default to enforce mode or recommend explicit `session.maintenance.mode: enforce` with tuned `maxEntries`/`pruneAfter`.

---

## 6) Completed run cleanup path in `pi-embedded-runner` looks correct (no obvious leak)

### Evidence checked

- Subscription is unsubscribed in finally:
  - `src/agents/pi-embedded-runner/run/attempt.ts:1995-2007`
- Active run handle removed:
  - `src/agents/pi-embedded-runner/run/attempt.ts:2005`
  - map delete logic in `src/agents/pi-embedded-runner/runs.ts:221-233`
- Session/tool resources disposed and lock released:
  - `src/agents/pi-embedded-runner/run/attempt.ts:2082-2091`
- Outer context engine disposed:
  - `src/agents/pi-embedded-runner/run.ts:1540`

### Caveat

There are large transient copies (`messages.slice()`) around compaction timeout handling:

- `src/agents/pi-embedded-runner/run/attempt.ts:1798`, `1872`
  This can spike memory during heavy contexts but appears temporary, not persistent retention.

---

## Priority recommendations

1. Implement true transcript pruning/rewriting for compacted history (highest ROI).
2. Add bounded eviction for `workspaceFileCache` and bootstrap snapshot cache.
3. Fix stale-entry cleanup in `session-manager-cache`.
4. Run gateway with enforced session maintenance caps.
5. Add runtime metrics for all long-lived maps and session file sizes to confirm impact.
