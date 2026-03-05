# memory-neo4j Audit — Round 2 — 2026-03-05

_4 agents: Scout + Architecture + Security + Performance_

---

## Executive Summary

Round 2 confirms all four OP-93/94/95/96 fixes are present and correct, with one caveat on OP-95. Net-new findings surface two high-priority issues not tracked in Jira: (1) the `sleepCycle.auto` config flag is silently dead — auto consolidation never runs — and (2) the credential scanner misses both Anthropic (`sk-ant-api03-*`) and new OpenAI project key (`sk-proj-*`) formats, which are the most common key types in OpenClaw deployments. Multiple performance N+1 patterns and a `resolveEnvVars` env-var exfiltration path round out the new findings.

---

## ✅ P0 Fixes Verified (from Round 1)

| ID        | Status             | Notes                                                                                                                                                                                                                                                                                                                                      |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OP-93** | ✅ In and working  | `findDuplicateEntityPairs` fulltext pre-filter replaces O(N²) Cartesian scan. No regressions observed.                                                                                                                                                                                                                                     |
| **OP-94** | ✅ In and working  | Credential scan paginates via `SKIP $offset` in Phase 5b. Caveat: cursor advances by `batch.length` including deleted records — see NEW-Sec-4 for a minor one-cycle miss edge case.                                                                                                                                                        |
| **OP-95** | ✅ Partially wired | `sleepAbortController.signal` correctly passed to `runAutoCapture` (index.ts:810) and fires on service `stop()` (index.ts:836). **Gap:** CLI-triggered `runSleepCycle` (cli.ts:421) receives no abort signal — a mid-cycle gateway shutdown cannot abort a CLI-initiated sleep run. Auto-capture path is fully protected; CLI path is not. |
| **OP-96** | ✅ In and working  | Tests for `detectConflicts`, `supersedeMemory`, `migrateTemporalFields`, and orchestrator phases are present and passing.                                                                                                                                                                                                                  |

---

## 🔴 New Critical Issues (P0)

### NEW-Arc-1 · `sleepCycle.auto` is dead config — consolidation never runs automatically

`config.ts:426–478` parses `sleepCycle.auto` (default `true`) into `cfg.sleepCycle.auto`. This flag is **never read** anywhere in `index.ts` or `cli.ts`. No auto-sleep scheduling is set up. Users who rely on automatic memory consolidation get none; the only path is an explicit `openclaw memory sleep` CLI call. This silently negates the plugin's primary offline consolidation feature for all users who haven't noticed the missing scheduling.

**File:** `config.ts:426`, `index.ts` (entirely absent)
**Fix:** Wire up a `setInterval` (or equivalent timer) in the plugin `start()` service using `cfg.sleepCycle.auto` and `cfg.sleepCycle.autoIntervalMs`.

---

## 🟠 Existing P1s — Additional Context

| ID         | Additional Detail                                                                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OP-97**  | `storeMemory` at neo4j-client.ts:251 is the exact zero-check entry point. Window of exposure: credential is immediately recallable after store and persists until Phase 5b runs. If `sleepCycle.auto` is dead (NEW-Arc-1), Phase 5b may never run at all.                                                   |
| **OP-98**  | neo4j-client.ts:85 logs `this.uri` at `info` level. Compound risk: combined with NEW-Sec-2, an attacker can craft a URI containing `${AWS_SECRET_ACCESS_KEY}` which resolves before logging, exfiltrating arbitrary env vars via the log. Fix: `new URL(uri)` → redact `password` component before logging. |
| **OP-99**  | `getMemoryStats()` at neo4j-client.ts:348 has no `agentId` parameter at all — returns full cross-agent breakdown to any caller. `reindex()` (neo4j-client.ts:2004) is also fully unscoped. `findOrphanEntities/Tags` are architecturally global by design (shared Entity graph) — not a bug.                |
| **OP-100** | sleep-cycle.ts:299 interpolates `taskTitle` directly into system prompt string in `classifyTaskMemory`. TASKS.md is user-writable. Sanitize by stripping/escaping quotes and newlines from `taskTitle` before interpolation, or move title to a `user` role message.                                        |
| **OP-101** | Architecture agent confirms split: `tools.ts` (~295 LOC), `lifecycle-hooks.ts` (~350 LOC), `capture.ts` (~240 LOC), `index.ts` residual (~100 LOC). Also note: `sleep-cycle.ts` at 1647 LOC is itself a secondary god-file warranting similar treatment.                                                    |
| **OP-102** | Two `before_agent_start` handlers at index.ts:492 and :548. SDK "last writer wins" semantics may silently drop Handler 1's `prependContext` (core-memory-refresh) whenever Handler 2 (auto-recall) fires. No test covers both handlers firing on the same turn.                                             |
| **OP-103** | `openclaw.plugin.json` JSON Schema entirely missing `conflictDetection` block and `autoCaptureAssistant` field. Also: `autoIntervalMs` is in `assertAllowedKeys` (config.ts:425) but absent from TS type and JSON Schema — a silent no-op backwards-compat shim.                                            |
| **OP-104** | Duplicate abort-aware delay pattern located at sleep-cycle.ts:872–883 (Phase 2) and :964–975 (Phase 2b) — identical `Promise<void>` + `setTimeout` + `abort` listener blocks. Extract to `abortableDelay(ms, signal)` helper.                                                                               |
| **OP-105** | Four call sites: sleep-cycle.ts:677 (Phase 1b), :726/:734 (Phase 1c), :1061–1066 (Phase 3b), :1443–1445 (Phase 7). Worst case ~800 sequential DB sessions at 1000 memories. Fix: `invalidateMemories(ids[])` using `UNWIND` (pattern already exists in `recordRetrievals` at neo4j-client.ts:760).          |
| **OP-106** | sleep-cycle.ts:783–800 (Phase 1d entity dedup). Bounded at 7 rel types per memory (ALLOWED_RELATIONSHIP_TYPES). Moderate severity.                                                                                                                                                                          |
| **OP-107** | sleep-cycle.ts:1561–1613 Phase 8 tips. Up to 50 tips × 3 sequential async ops = 150 roundtrips. Fix: `embedMany(texts[])` batch then UNWIND store.                                                                                                                                                          |
| **OP-108** | No index on `Memory.taskId`. Phase 7 calls `findMemoriesByTaskId` in a per-task loop (N+1), each hitting a full node scan. Also: `bm25Search`/`vectorSearch` apply `agentId` as post-filter after full index scan — degrades at multi-agent scale.                                                          |
| **OP-109** | 13 sequential DDL `await` calls in `ensureIndexes` (neo4j-client.ts:98–183). Trivial `Promise.all` fix but note: `runSafe` reuses the same session — need per-index sessions or batched DDL to parallelize safely.                                                                                          |
| **OP-110** | mid-session-refresh tests use a local copy of the module. Still open; not addressed in Round 2.                                                                                                                                                                                                             |
| **OP-111** | Silent false-positive in auto-capture test. Still open.                                                                                                                                                                                                                                                     |
| **OP-112** | Neo4j client method coverage gaps. Still open.                                                                                                                                                                                                                                                              |

---

## 🟡 New P1/P2 Issues (Net New from Round 2)

### Architecture

- **[Arc-2] `retroactiveConflictScan` missing from `onPhaseStart` union type** | sleep-cycle.ts:1089 | Add `"retroactiveConflictScan"` to the `SleepCycleOptions.onPhaseStart` parameter union; also add entries to `cli.ts:435–448` phaseNames map for `retroactiveConflictScan`, `taskMemoryCleanup`, `temporalStaleness` — currently these phases print raw key names.

- **[Arc-3] Phase 5 `onProgress` emits under wrong phase name** | sleep-cycle.ts:1215 | Emits `"cleanup"` (Phase 4's key) instead of `"noiseCleanup"`. Any progress listener will misattribute Phase 5 noise-cleanup activity to Phase 4.

- **[Arc-4] Phase 2b N+1 probe query + inaccurate `total` stat** | sleep-cycle.ts:919–921, :959 | Extra `db.listUntaggedMemories(1, agentId)` per loop to check for more items — replace with `untagged.length >= retroactiveTagBatchSize`. `result.retroactiveTagging.total` is set from first batch size (≤50), not true count; summary shows "0/50 tagged" even with thousands pending.

- **[Arc-5] CLI sleep summary silently drops Phase 3b/3c/7 results** | cli.ts:460–490 | `temporalStaleness.memoriesRemoved`, `retroactiveConflictScan.memoriesSuperseded`, and `taskMemoryCleanup.memoriesRemoved` are not rendered in the summary table.

- **[Arc-6] Dynamic `node:fs/promises` / `node:path` imports in hot-path functions** | index.ts:622, :870 | `await import("node:fs/promises")` and `await import("node:path")` inside functions that execute per auto-capture turn. These are Node built-ins (cached after first load) but violate the repo's dynamic-import guardrail (CLAUDE.md) and add unnecessary microtask overhead on every call. Move to static imports or a `*.runtime.ts` boundary.

- **[Arc-7] Unguarded `new RegExp()` in config parsing crashes gateway on malformed input** | config.ts:462–470 | `autoCaptureSkipPattern` and `autoRecallSkipPattern` compiled with bare `new RegExp(str)` — a syntactically invalid pattern throws synchronously and kills plugin initialization. Wrap in try/catch and surface a config-validation error instead.

### Security

- **[Sec-1] Credential scanner misses Anthropic and new OpenAI project key formats** | sleep-cycle.ts:224 | Pattern `/\bsk[_-][a-z0-9]{16,}/i` fails to match `sk-ant-api03-*` (Anthropic) and `sk-proj-*` (new OpenAI) because the segment after `sk-` contains dashes. Add: `{ pattern: /\bsk-ant-[a-zA-Z0-9-]{20,}/i, label: "Anthropic API key" }` and `{ pattern: /\bsk-proj-[a-zA-Z0-9]{20,}/i, label: "OpenAI project key" }`.

- **[Sec-2] `resolveEnvVars` has no env-var allowlist — arbitrary secret exfiltration via URI logging** | config.ts:162–169 | Any `${VAR_NAME}` reference in `neo4j.uri` is resolved from `process.env` without restriction. Combined with OP-98, setting `neo4j.uri = "bolt://${AWS_SECRET_ACCESS_KEY}@host"` resolves and logs the secret at `info` level on startup. Restrict to a pattern like `/^(NEO4J_|OPENAI_|ANTHROPIC_|MEMORY_)/` or log only after redaction.

- **[Sec-3] User-controlled regex skip patterns — ReDoS in hot path** | config.ts:461–469 | `autoCaptureSkipPattern` / `autoRecallSkipPattern` accept arbitrary regex strings from plugin config. A catastrophically backtracking pattern (e.g., `(a+)+b`) evaluated against every auto-captured message can stall the event loop. Validate pattern length and test with a timeout before accepting.

- **[Sec-4] Credential scan SKIP cursor skips records after in-batch deletions** | sleep-cycle.ts:1274 | After deleting N records in batch K, the `SKIP` offset for batch K+1 is inflated by N, causing the records immediately following the deleted set to be skipped for one cycle. Low severity (next cycle catches them) but worth noting for correctness.

- **[Sec-5] Prompt injection in entity extraction (user-role memory text)** | extractor.ts:136–139 | Memory text passed as `role: "user"` to extraction LLM with no stripping. An adversary can craft memory text to force `category: "core"`, making the memory immune to decay. `validateExtractionResult` provides partial mitigation on category/entity-type allowlists.

### Performance

- **[Perf-1] Phase 3c `detectConflicts` is fully sequential — up to 100 serial LLM calls** | sleep-cycle.ts (Phase 3c) | With default `sleepScanBatchSize=20` and up to 5 batches, all conflict-pair LLM classification calls run sequentially. Batch with `Promise.allSettled` up to a concurrency limit (e.g., 5 parallel).

- **[Perf-2] `findConflictingMemories` includes already-invalidated memories** | neo4j-client.ts:1735–1742 | Cypher query lacks `AND m1.validUntil IS NULL AND m2.validUntil IS NULL`. Dead memory pairs sent to LLM resolution unnecessarily — at 15% invalidation rate, ~15% of Phase 1c LLM calls are wasted.

- **[Perf-3] `listPendingExtractions` includes invalidated memories** | neo4j-client.ts:1018–1024 | Filter `extractionStatus IN ['pending','skipped']` does not exclude `validUntil IS NOT NULL`. Invalidated memories queued for extraction waste Phase 2 LLM calls. Add `AND m.validUntil IS NULL`.

- **[Perf-4] Phase 7 N+1 BM25 searches — one per completed task** | sleep-cycle.ts:1384–1405 | `searchMemoriesByKeywords` called sequentially for each recently completed task. At 20 tasks × ~10ms = 200ms serial latency. Merge all task keywords into a single OR query or run with `Promise.allSettled`.

- **[Perf-5] No index on `Memory.taskId`** | neo4j-client.ts:791 | `findMemoriesByTaskId` and `clearTaskIdFromMemories` do full node scans. Add `CREATE INDEX memory_task_id_index IF NOT EXISTS FOR (m:Memory) ON (m.taskId)`. Phase 7 calls this in a per-task loop, compounding the scan cost.

- **[Perf-6] SKIP-based credential scan pagination is O(N²) at scale** | sleep-cycle.ts:1238–1275 | `ORDER BY createdAt ASC / SKIP $offset` re-scans from the beginning on each page. At 100K memories, the last page requires scanning all preceding records. Switch to cursor-based pagination using `WHERE m.createdAt > $lastSeen`.

---

## Priority Action List

1. **Fix OP-98 (URI password logging)** — one-liner: redact password from URI before `this.logger.info`. Highest risk, trivial fix. (`neo4j-client.ts:85`)
2. **Fix NEW-Sec-1 (missing Anthropic/OpenAI key patterns)** — add two regex entries to `CREDENTIAL_PATTERNS`. Critical for the most common key types in use. (`sleep-cycle.ts:224`)
3. **Fix NEW-Arc-1 (dead `sleepCycle.auto` flag)** — wire up the scheduler in service `start()`; without it, auto-consolidation never runs for any user. (`index.ts`)
4. **Fix NEW-Sec-2 (resolveEnvVars allowlist)** — add env-var name validation before resolution to prevent secret exfiltration via URI logging. (`config.ts:162`)
5. **Fix OP-105 (batch invalidateMemory)** — add `invalidateMemories(ids[])` using UNWIND; apply at all 4 call sites. Worst-case 800 serial DB sessions eliminated. (`neo4j-client.ts`, `sleep-cycle.ts`)
6. **Fix OP-95 gap (CLI sleep abort signal)** — pass an AbortController signal to `runSleepCycle` from the CLI path so mid-cycle shutdown is safe. (`cli.ts:421`)
7. **Fix NEW-Perf-2/3 (dead-memory filtering in conflict/extraction queries)** — add `AND m.validUntil IS NULL` guards; eliminates wasted LLM calls on already-invalidated memories. (`neo4j-client.ts:1735`, `:1018`)
8. **Fix NEW-Arc-3/5 (wrong phase name in onProgress + missing CLI summary fields)** — `"cleanup"` → `"noiseCleanup"` in Phase 5 emit; add Phase 3b/3c/7 rows to CLI summary table. (`sleep-cycle.ts:1215`, `cli.ts:460`)
9. **Fix OP-108 + NEW-Perf-5 (missing taskId index)** — single DDL statement; eliminates full-scan in Phase 7 N+1 loop. (`neo4j-client.ts:ensureIndexes`)
10. **Fix OP-100 (task title prompt injection)** — sanitize `taskTitle` (strip/escape quotes and newlines) before interpolating into LLM system prompt. (`sleep-cycle.ts:299`)
