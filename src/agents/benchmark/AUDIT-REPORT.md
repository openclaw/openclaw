# Agent Subsystem Performance & Code Quality Audit

**Date:** 2026-03-07
**Scope:** `src/agents/` (81,375 LOC across ~250 non-test source files)
**Benchmark platform:** Darwin 25.3.0 | Apple M3 Max | Bun/Node v24.3.0

---

## 1. Benchmark Baseline

```
Metric                                      Current   Unit   Notes
──────────────────────────────────────────  ────────  ─────  ──────────────────────────────
Module import: model-selection                280     ms     cold import (transitive deps)
Module import: pi-embedded-runner/run         647     ms     cold import, heaviest module
Module import: system-prompt                    3     ms     cold import
normalizeProviderId (10k x 7 providers)         2     ms     38M ops/sec — no issue
parseModelRef (10k x 4 refs)                    6     ms     7M ops/sec — no issue
buildModelAliasIndex (1k iterations)            2     ms     4 model entries
Auth profile store: cold load                 0.2     ms     disk read + parse
Auth profile store: warm load (100x)            2     ms     cached path
Workspace bootstrap: cold load                2.5     ms     3 files, boundary-safe open
Workspace bootstrap: warm load                0.9     ms     inode identity cache hit
resolveExecDetail (1k x 6 commands)            20     ms     shell parsing + summarization
countActiveDescendantRuns (1k, 50 runs)        43     ms     graph traversal (recursive)
listRunsForRequester (1k, 50 runs)              2     ms     linear scan
```

Benchmark script: `src/agents/benchmark/agent-benchmark.ts`

---

## 2. Findings Report

### CRITICAL

#### C1. `pi-embedded-runner/run/attempt.ts` — 2,076 LOC monolith

**File:** `pi-embedded-runner/run/attempt.ts`
**Impact:** Maintainability, cold-start latency (647ms import chain), cognitive load.

The `runEmbeddedAttempt` function is a single ~1,800-line function that handles session creation, tool setup, stream wrapping, history sanitization, prompt building, hook execution, abort handling, and result collection. This is the single most critical function in the agent runtime.

**Suggested fix:** Extract into focused modules:

- `attempt-session-setup.ts` — session manager init, lock, repair
- `attempt-stream-wrappers.ts` — all `wrapStreamFn*` functions (already partially extracted)
- `attempt-prompt-build.ts` — system prompt assembly, hook integration
- `attempt-result.ts` — result collection, payload building

#### C2. `pi-embedded-runner/run.ts` — 1,489 LOC with deep retry nesting

**File:** `pi-embedded-runner/run.ts`
**Impact:** The outer run loop (`while(true)`) with auth profile rotation, thinking fallback, overflow compaction, and copilot token refresh creates deeply nested control flow that's hard to reason about and test.

**Suggested fix:** Extract retry strategies into a state machine or strategy pattern. Each retry reason (auth rotation, thinking fallback, overflow compaction, copilot refresh) should be a discrete handler.

### HIGH

#### H1. `subagent-registry.ts` — Repeated `loadConfig()` calls in hot paths

**File:** `subagent-registry.ts:160,319,634,673,1092,1154`
**Impact:** `loadConfig()` is called 6+ times within the subagent registry. While it has a runtime snapshot cache, the fallback path reads from disk. In the announce flow, `loadConfig()` is called in `resolveArchiveAfterMs`, `resolveSubagentWaitTimeoutMs`, `registerSubagentRun`, and `sweepSubagentRuns`.

**Suggested fix:** Pass `cfg` as a parameter or resolve once at the entry point and thread through.

#### H2. `subagent-announce.ts` — Repeated `loadConfig()` + `loadSessionStore()` calls

**File:** `subagent-announce.ts:433,581,641,747,885,1085`
**Impact:** The announce flow calls `loadConfig()` 6 times and `loadSessionStore()` multiple times per announce cycle. Each `loadSessionStore()` does a stat + potential disk read.

**Suggested fix:** Resolve config and session store once at the top of `runSubagentAnnounceFlow` and pass through.

#### H3. `countActiveDescendantRunsFromRuns` — O(n\*d) graph traversal

**File:** `subagent-registry-queries.ts` (called from `subagent-registry.ts`)
**Impact:** 43ms per 1,000 calls with 50 runs. This is a recursive BFS/DFS over the run graph. With deeply nested subagent trees (depth 3+), this becomes expensive and is called on every announce cleanup cycle.

**Suggested fix:** Maintain a pre-computed parent->children index (Map) that's updated on register/complete instead of scanning all runs each time.

#### H4. `subagent-registry.ts` — `persistSubagentRuns()` called on every mutation

**File:** `subagent-registry.ts` (called ~30 times across the file)
**Impact:** Every field update (endedAt, outcome, cleanupHandled, etc.) triggers a full JSON serialization + disk write of the entire runs map. During a burst of subagent completions, this creates write amplification.

**Suggested fix:** Debounce persistence with a 100-500ms coalesce window. Use a dirty flag + `setImmediate`/`setTimeout` pattern.

#### H5. `tool-display-common.ts` — 1,234 LOC of shell command parsing

**File:** `tool-display-common.ts`
**Impact:** 20ms per 6,000 command summaries. The shell parsing (`splitShellWords`, `scanTopLevelChars`, `stripShellPreamble`) is called for every bash tool execution display. The character-by-character scanning with quote tracking is correct but allocates many intermediate arrays.

**Suggested fix:** Consider caching `resolveExecDetail` results by command string (LRU cache, ~100 entries). Many commands repeat across sessions.

### MEDIUM

#### M1. `auth-profiles/store.ts` — `structuredClone` on every runtime store access

**File:** `auth-profiles/store.ts:28`
**Impact:** `cloneAuthProfileStore` uses `structuredClone` which deep-copies the entire store. Called from `resolveRuntimeAuthProfileStore` which is invoked on every `ensureAuthProfileStore` call.

**Suggested fix:** Use copy-on-write semantics or freeze the returned object instead of cloning.

#### M2. `workspace.ts` — Sequential file reads in `loadWorkspaceBootstrapFiles`

**File:** `workspace.ts:480-510`
**Impact:** Bootstrap files (AGENTS.md, SOUL.md, TOOLS.md, IDENTITY.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md, MEMORY.md) are read sequentially in a `for` loop. With 8+ files, this serializes I/O.

**Suggested fix:** Use `Promise.all` for parallel reads (the boundary-safe open + inode cache already handles race conditions).

#### M3. `workspace.ts` — `syncFs.readFileSync` in `readWorkspaceFileWithGuards`

**File:** `workspace.ts:79`
**Impact:** Uses synchronous `readFileSync` on the hot path of workspace bootstrap loading. While the fd is already open, this blocks the event loop during the read.

**Suggested fix:** Use `fs.promises.readFile` (or `fs.read` on the fd) for async I/O.

#### M4. `model-selection.ts` — `findNormalizedProviderValue` linear scan

**File:** `model-selection.ts:78-86`
**Impact:** Iterates all entries in a config record, calling `normalizeProviderId` on each key. Called during model resolution.

**Suggested fix:** Pre-build a normalized provider key map at config load time.

#### M5. `pi-embedded-runner/run.ts` — Massive parameter pass-through

**File:** `pi-embedded-runner/run.ts:700-780` (the `runEmbeddedAttempt` call)
**Impact:** ~80 parameters are individually listed in the `runEmbeddedAttempt` call. This is a code quality issue — any parameter addition requires touching 3+ files.

**Suggested fix:** Group related params into typed context objects (e.g., `SessionContext`, `AuthContext`, `StreamContext`).

#### M6. Files exceeding 500 LOC guideline (non-test)

**Impact:** 48 source files exceed the 500 LOC guideline. Top offenders:

- `pi-embedded-runner/run/attempt.ts` — 2,076 LOC
- `tools/web-search.ts` — 1,687 LOC
- `pi-embedded-runner/run.ts` — 1,489 LOC
- `subagent-announce.ts` — 1,479 LOC
- `subagent-registry.ts` — 1,450 LOC
- `tool-display-common.ts` — 1,234 LOC
- `models-config.providers.ts` — 1,231 LOC
- `pi-embedded-runner/extra-params.ts` — 1,156 LOC

### LOW

#### L1. `identity-file.ts:93` — `readFileSync` for identity file

**File:** `identity-file.ts:93`
**Impact:** Sync read on a potentially large identity file. Low frequency but blocks event loop.

#### L2. `skills/workspace.ts:393` — `readFileSync` for skill files

**File:** `skills/workspace.ts:393`
**Impact:** Sync read for each skill file during workspace resolution.

#### L3. `subagent-depth.ts:39` — `readFileSync` for session store

**File:** `subagent-depth.ts:39`
**Impact:** Sync JSON parse of session store to determine subagent depth.

#### L4. `pi-model-discovery.ts:59,88` — Sync read/write for model discovery cache

**File:** `pi-model-discovery.ts:59,88`
**Impact:** Sync I/O for model discovery JSON. Low frequency (startup only).

---

## 3. Hot Path Analysis

### Critical Path: Message → Response

```
User Message
  → Gateway dispatch
    → runEmbeddedPiAgent (run.ts)                    [~650ms cold, ~5ms warm]
      → resolveModel + auth profile resolution       [~1ms]
      → ensureOpenClawModelsJson                     [~2ms cold, cached warm]
      → Hook execution (before_model_resolve)        [~1ms]
      → runEmbeddedAttempt (attempt.ts)              [bulk of time]
        → Workspace mkdir                            [~0.5ms]
        → Sandbox resolution                         [~1ms]
        → Skill resolution + env overrides           [~2ms]
        → Bootstrap file loading                     [~2.5ms cold, ~1ms warm]
        → System prompt assembly                     [~3ms]
        → Session file repair + lock                 [~2ms]
        → SessionManager.open + history sanitize     [~5-50ms depending on history]
        → Context engine assemble                    [~2-10ms]
        → Tool creation                              [~5ms]
        → Stream function wrapping (5-7 layers)      [~0.1ms]
        → LLM API call                               [variable, 500ms-30s]
        → subscribeEmbeddedPiSession                 [streaming, variable]
        → Tool execution loop                        [variable]
      → Auth profile good/used marking               [~1ms]
      → Usage accumulation                           [~0.1ms]
```

### Parallelization Opportunities

1. **Bootstrap file loading + tool creation** — These are independent and could run in parallel (~5ms savings).
2. **System prompt assembly + session file repair** — Independent operations.
3. **Workspace bootstrap files** — 8 sequential reads could be parallel (M2 above).

---

## 4. Quick Wins (Top 5, highest impact-to-effort ratio)

### QW1. Debounce `persistSubagentRuns()` (H4)

**Impact:** High — eliminates write amplification during subagent completion bursts
**Effort:** Low — ~20 lines of debounce logic
**Expected improvement:** 5-10x fewer disk writes during multi-subagent scenarios

### QW2. Thread `loadConfig()` through subagent-announce flow (H2)

**Impact:** High — eliminates 6+ redundant config resolutions per announce
**Effort:** Low — add `cfg` parameter to 3-4 functions
**Expected improvement:** Eliminates potential disk reads on non-cached paths

### QW3. Parallelize workspace bootstrap file reads (M2)

**Impact:** Medium — saves ~1-2ms per agent spawn on cold path
**Effort:** Low — change `for` loop to `Promise.all`
**Expected improvement:** 30-50% faster bootstrap loading

### QW4. Pre-compute subagent parent→children index (H3)

**Impact:** Medium-High — eliminates O(n\*d) traversal on every cleanup cycle
**Effort:** Medium — maintain index on register/complete/delete
**Expected improvement:** O(1) lookups instead of O(n) scans for descendant queries

### QW5. Cache `resolveExecDetail` results (H5)

**Impact:** Medium — saves ~3ms per tool display cycle with repeated commands
**Effort:** Low — LRU cache with ~100 entries
**Expected improvement:** Near-zero cost for repeated command summaries

---

## 5. Benchmark Location Recommendation

**Recommended:** `src/agents/benchmark/`

Rationale:

- Co-located with the code being measured (easy to update when APIs change)
- Not in `docs/` (benchmarks are executable code, not documentation)
- Not at repo root (keeps root clean per project conventions)
- Follows the pattern of colocated tests (`*.test.ts` alongside source)
- Can be run with `bun src/agents/benchmark/agent-benchmark.ts`

The benchmark script is already placed there. If you prefer a different location, let me know.
