# Phase 3C — Manual Remediation Executor

**Status:** Spec (not yet implemented)  
**Author:** Adx  
**Date:** 2026-03-20  
**Depends on:** Phase 3A (remediation plan builder), 3B (trust-fix + UX honesty)  
**Constraint:** Spec only — no implementation in this pass

---

## 1. Design Intent

Phase 3A gave us a pure-function remediation planner: it reads a snapshot and produces a structured plan. Phase 3B made the output trustworthy and honest. Phase 3C adds the **execution path** — the ability to actually carry out reviewed remediation actions.

The execution model is explicitly **surgical approval tooling**, not garbage-collection automation. The operator reviews a dry-run plan, selects specific actions by ID, and executes them one at a time (or in a reviewed batch). The system refuses to execute anything the operator hasn't explicitly selected from a recent, verified plan.

**Core product principle:** Review-first, agree-first, delete-later.

---

## 2. Operator Flow: Dry-Run to Execution

### Step 1: Generate & Review Plan (existing)

```
openclaw sessions cleanup --dry-run
```

Outputs the maintenance preview + remediation plan as today. Each action has a stable `id` field (e.g., `cleanup-orphaned-tmp-1`, `archive-orphan-transcripts-2`).

### Step 2: Execute Selected Actions

```
openclaw sessions cleanup --execute <action-id> [<action-id>...]
```

The operator cherry-picks specific action IDs from the dry-run output. The executor:

1. Re-collects a fresh snapshot
2. Re-generates the plan
3. Validates that every requested action ID still exists in the fresh plan
4. Validates that the fresh plan's action parameters match (affected counts, etc.)
5. Shows a **confirmation prompt** with exactly what will happen
6. Executes on explicit `y` confirmation
7. Prints a before/after report

### Step 3: Review Result

The executor prints a structured before/after report showing exactly what changed.

### Alternative: Execute All Actions in a Tier

```
openclaw sessions cleanup --execute-tier 0
openclaw sessions cleanup --execute-tier 1
```

Convenience for "execute all Tier 0 actions" or "all Tier 0 + Tier 1 actions." Same validation and confirmation flow. v1 supports `--execute-tier 0` and `--execute-tier 1` only. The command refuses `--execute-tier 2` and `--execute-tier 3`.

---

## 3. Plan Identity & Staleness

### 3.1 Why Not Plan Hashes or Tokens?

We considered three approaches for referencing reviewed plans:

| Approach                   | Pros                                      | Cons                                                                   |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| **Plan hash**              | Cryptographic proof of plan identity      | Brittle — any snapshot drift invalidates; forces unnecessary re-review |
| **Timestamped plan token** | Can enforce staleness windows             | Adds token lifecycle management; over-engineered for CLI               |
| **Re-derive and validate** | Always fresh; no stale tokens; no storage | Requires re-collection (cheap: ~5ms)                                   |

**Decision: Re-derive and validate.** The executor re-collects a fresh snapshot, re-builds the plan, and validates that the requested action IDs still exist with compatible parameters. This is the simplest approach that is also the most correct — it guarantees the operator is executing against current reality, not a stale plan.

### 3.2 Staleness Protection

Even with re-derivation, we add a staleness check:

- The executor compares the fresh plan's action parameters against what the operator reviewed
- If an action's `affectedCount` has **increased** since the dry-run, the executor warns and requires re-confirmation
- If an action's `affectedCount` has **decreased** (things cleaned themselves up), the executor proceeds — fewer affected items is strictly safer
- If an action ID no longer exists in the fresh plan (the problem resolved itself), the executor skips it with a notice

### 3.3 Action ID Stability

Action IDs are currently generated with a monotonic counter (`cleanup-orphaned-tmp-1`). This is stable within a single plan generation but not across plan re-generations. Since we re-derive, the IDs will be identical as long as the plan builder's action ordering is deterministic (it is — the builder iterates action kinds in a fixed order).

**Guarantee:** Action IDs are deterministic for a given snapshot shape. If the snapshot changes materially, the plan changes, and the executor detects this via parameter validation.

---

## 4. v1 Supported Action Set

### Tier 0 — Auto-Safe (v1: YES)

| Action Kind            | What It Does                                    | Reversible                              | Risk      |
| ---------------------- | ----------------------------------------------- | --------------------------------------- | --------- |
| `cleanup-orphaned-tmp` | Deletes `.tmp` files from crashed atomic writes | No (but these are definitional garbage) | Near-zero |

### Tier 1 — Retention Cleanup (v1: YES, safest subset)

| Action Kind                         | What It Does                                                | Reversible               | Risk                                          |
| ----------------------------------- | ----------------------------------------------------------- | ------------------------ | --------------------------------------------- |
| `archive-orphan-transcripts`        | Renames unindexed `.jsonl` files to `.deleted.<timestamp>`  | Yes (rename, not delete) | Low — preserves data                          |
| `archive-stale-deleted-transcripts` | Permanently removes `.deleted` files past retention window  | No                       | Low — already soft-deleted and past retention |
| `archive-stale-reset-transcripts`   | Permanently removes `.reset` archives past retention window | No                       | Low — already archived and past retention     |

**Why include all Tier 1:** All three Tier 1 actions operate on artifacts that are either already soft-deleted or explicitly orphaned. The `archive-orphan-transcripts` action is reversible (rename, not delete). The other two remove artifacts that are already past their operator-configured retention window. This is cleanup of acknowledged waste, not speculative pruning.

### Tier 2 — Index-Mutating (v1: NO)

Not included in v1. Index mutations affect which sessions are visible to the operator and loadable by the agent runtime. Even though the pruning targets (stale cron-runs, subagents, heartbeats, ACP sessions) are ephemeral by design, modifying the session index is a qualitatively different operation that should be proven safe in isolation before enabling.

**Revisit in Phase 3D** after v1 executor has production mileage.

### Tier 3 — Destructive (v1: NO)

Not included in v1. Tier 3 actions (disk budget enforcement, archived artifact purge, bulk class prune) are high-consequence operations. They require more sophisticated safety rails (dry-run impact analysis, undo snapshots, progressive rollout) that are out of scope for v1.

---

## 5. Command Surface

### 5.1 Extend Existing Command

The executor extends `openclaw sessions cleanup` rather than adding a new subcommand. Rationale:

- The operator is already in the `sessions cleanup` mental model
- Dry-run → execute is a natural progression within the same command
- Adding a separate command fragments the workflow

### 5.2 New Flags

```
--execute <id...>      Execute specific remediation action(s) by ID.
                       Requires prior --dry-run review.
                       Refuses Tier 2+ actions in v1.

--execute-tier <n>     Execute all actions in the specified tier (0 or 1).
                       Shorthand for --execute with all action IDs in that tier.
                       Refuses tier values > 1 in v1.

--yes                  Skip interactive confirmation prompt.
                       Still prints the confirmation summary.
                       For scripted/CI use. Does NOT bypass tier restrictions.

--json                 (existing) Also applies to execution reports.
```

### 5.3 Flag Interactions

| Flags                      | Behavior                                                                                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`                | Existing: preview only, no mutations                                                                                       |
| `--execute <id>`           | Execute selected action(s) from fresh plan                                                                                 |
| `--execute-tier 0`         | Execute all Tier 0 actions from fresh plan                                                                                 |
| `--execute-tier 1`         | Execute all Tier 0 + Tier 1 actions (Tier 1 implies Tier 0)                                                                |
| `--execute <id> --yes`     | Execute without interactive confirmation                                                                                   |
| `--execute <id> --dry-run` | **Refused.** Contradictory flags.                                                                                          |
| `--enforce --execute <id>` | **Refused.** `--enforce` is the legacy maintenance path; `--execute` is the remediation path. They are separate codepaths. |

### 5.4 UX Examples

```bash
# Step 1: Review
$ openclaw sessions cleanup --dry-run

# ... reads plan, sees action IDs ...

# Step 2: Execute one action
$ openclaw sessions cleanup --execute cleanup-orphaned-tmp-1

# Step 3: Execute all safe actions
$ openclaw sessions cleanup --execute-tier 0

# Step 4: Execute Tier 0 + Tier 1
$ openclaw sessions cleanup --execute-tier 1

# Step 5: Scripted execution
$ openclaw sessions cleanup --execute-tier 0 --yes --json
```

---

## 6. Confirmation Prompt

Before execution, the system prints a confirmation block:

```
══════════════════════════════════════════════════════════
  REMEDIATION EXECUTION — CONFIRMATION REQUIRED
══════════════════════════════════════════════════════════

  Actions to execute:

  ▸ cleanup-orphaned-tmp-1 [Tier 0, auto-safe]
    Delete 3 orphaned .tmp file(s) from crashed atomic writes.
    Impact: 3 artifact(s), 12.4 KB

  Total: 1 action(s), 3 artifact(s), ~12.4 KB

  Proceed? [y/N]
```

The prompt defaults to **No**. The operator must type `y` or `yes`.

With `--yes`, the confirmation block is still printed but the prompt is skipped.

---

## 7. Refusal & Safety Rules

The executor **refuses** to proceed when:

| Condition                                                           | Error Message                                                                                                     | Rationale                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Requested action ID not found in fresh plan                         | `Action '{id}' not found in current plan. The underlying condition may have resolved. Re-run --dry-run.`          | Prevents executing against stale context          |
| Requested action is Tier 2+                                         | `Action '{id}' is Tier {n} ({label}). v1 only supports Tier 0–1 execution. Use --dry-run to review.`              | Hard safety boundary for v1                       |
| `--execute-tier` with value > 1                                     | `--execute-tier {n} is not supported in v1. Maximum: 1.`                                                          | Hard safety boundary                              |
| `--execute` with `--dry-run`                                        | `--execute and --dry-run are contradictory. Use one or the other.`                                                | Prevents confusion                                |
| `--execute` with `--enforce`                                        | `--execute uses the remediation plan path. --enforce uses legacy maintenance. Choose one.`                        | Keeps codepaths clean                             |
| No actions would execute (all resolved)                             | `All requested actions have resolved since the last dry-run. Nothing to execute.`                                 | Prevents empty execution                          |
| Fresh plan shows affectedCount **increased** for a requested action | `Action '{id}' now affects {n} artifacts (was {m} at review time). Re-run --dry-run to review the updated scope.` | Prevents scope creep between review and execution |

### 7.1 Idempotency

All v1 actions are idempotent:

- **`cleanup-orphaned-tmp`**: Re-running after completion finds 0 orphaned temp files → action vanishes from plan → executor reports "nothing to do"
- **`archive-orphan-transcripts`**: Re-running after archival finds 0 orphan transcripts → action vanishes from plan → executor reports "nothing to do"
- **`archive-stale-deleted-transcripts`**: Same — already-purged `.deleted` files won't appear in a fresh scan
- **`archive-stale-reset-transcripts`**: Same — already-purged `.reset` files won't appear in a fresh scan

If the operator runs the same `--execute` command twice, the second run will report "All requested actions have resolved" and exit cleanly.

---

## 8. Before/After Reporting

### 8.1 Text Report (default)

```
══════════════════════════════════════════════════════════
  REMEDIATION EXECUTION — COMPLETE
══════════════════════════════════════════════════════════

  Executed: 2 action(s)
  Skipped:  0
  Failed:   0

  ── cleanup-orphaned-tmp-1 ──
  Status:   ✓ complete
  Removed:  3 .tmp file(s)
  Freed:    12.4 KB

  ── archive-stale-deleted-transcripts-3 ──
  Status:   ✓ complete
  Removed:  7 .deleted file(s)
  Freed:    2.1 MB

  ── Storage Summary ──
  Before:   48.3 MB total managed
  After:    46.2 MB total managed
  Freed:    2.1 MB (4.4%)

══════════════════════════════════════════════════════════
```

### 8.2 JSON Report

```json
{
  "executedAt": "2026-03-20T22:00:00.000Z",
  "actions": [
    {
      "id": "cleanup-orphaned-tmp-1",
      "kind": "cleanup-orphaned-tmp",
      "tier": 0,
      "status": "complete",
      "artifactsRemoved": 3,
      "bytesFreed": 12700
    },
    {
      "id": "archive-stale-deleted-transcripts-3",
      "kind": "archive-stale-deleted-transcripts",
      "tier": 1,
      "status": "complete",
      "artifactsRemoved": 7,
      "bytesFreed": 2202009
    }
  ],
  "summary": {
    "executed": 2,
    "skipped": 0,
    "failed": 0,
    "totalBytesFreed": 2214709,
    "storageBefore": 50647040,
    "storageAfter": 48432331
  }
}
```

### 8.3 Per-Action Status Values

| Status     | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| `complete` | Action executed successfully                                  |
| `skipped`  | Action no longer applicable (condition resolved)              |
| `failed`   | Action failed (error message attached)                        |
| `refused`  | Action refused by safety rules (tier violation, scope change) |

### 8.4 Storage Summary

The before/after storage summary re-collects `totalManagedBytes` from a fresh snapshot after execution. This is the honest delta — not the sum of estimated impacts (which may differ from reality).

---

## 9. Executor Implementation Architecture

### 9.1 Execution Function Signature

```typescript
type ExecuteRemediationOptions = {
  /** Action IDs to execute (from the plan). */
  actionIds: string[];

  /** Skip interactive confirmation. */
  skipConfirmation: boolean;

  /** JSON output mode. */
  json: boolean;

  /** Agent/store targeting (reuse existing SessionStoreTarget). */
  target: SessionStoreTarget;
};

type ExecutionResult = {
  executedAt: string;
  actions: ActionExecutionResult[];
  summary: ExecutionSummary;
};
```

### 9.2 Action Executor Registry

Each action kind maps to an executor function:

```typescript
type ActionExecutor = (params: {
  action: RemediationAction;
  target: SessionStoreTarget;
  snapshot: SessionHealthRawSnapshot;
}) => Promise<ActionExecutionResult>;
```

v1 implements exactly 4 executors:

1. `executeCleanupOrphanedTmp` — `fs.unlink` for each `.tmp` file
2. `executeArchiveOrphanTranscripts` — `fs.rename` to `.deleted.<timestamp>`
3. `executeArchiveStaleDeletedTranscripts` — `fs.unlink` for each stale `.deleted` file
4. `executeArchiveStaleResetTranscripts` — `fs.unlink` for each stale `.reset` file

### 9.3 File Discovery

The executor needs to discover the specific files to act on. The current remediation plan only reports _counts_ (e.g., "3 orphaned .tmp files"), not file paths.

**Required implementation work:** The executor must either:

- (a) Add file-path lists to the `RemediationAction` type, populated by the plan builder, or
- (b) Re-discover files at execution time using the same logic the collector uses

**Recommendation:** Option (b) — re-discover at execution time. This is consistent with the re-derive-and-validate philosophy. The collector already walks the session directory; we extract the file-discovery logic into shared helpers that both the collector and executor can use.

### 9.4 Ordering

Actions execute in tier order (Tier 0 before Tier 1), then in plan order within a tier. This respects the `prerequisites` field on remediation actions.

### 9.5 Error Handling

- Each action executes independently. A failure in one action does not block others (unless it's a prerequisite).
- File-level errors (permission denied, file vanished) are caught per-file and reported in the action result.
- An action with partial failures reports `status: "complete"` with a `warnings` array if some files succeeded.
- An action where ALL files failed reports `status: "failed"`.

---

## 10. What Is Explicitly OUT of v1

| Feature                                       | Why Out                                                         | When to Revisit                            |
| --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| Tier 2 execution (index mutations)            | Qualitatively different risk — affects session visibility       | Phase 3D after v1 production mileage       |
| Tier 3 execution (destructive bulk ops)       | Needs undo snapshots, progressive rollout                       | Phase 3E or later                          |
| Automated/scheduled execution                 | Against core product constraint — no automation-first           | Phase 4 if operator demand justifies       |
| Background/daemon cleanup                     | Against core product constraint — no hidden mutations           | Not planned                                |
| `--execute-all` flag                          | Too broad — forces review of specific actions                   | Evaluate after v1                          |
| Plan persistence / saved plans                | Re-derive-and-validate makes this unnecessary                   | Only if operators request it               |
| Undo/rollback for Tier 1 irreversible actions | `.deleted`/`.reset` files past retention are acknowledged waste | Could add pre-execution backup in Phase 3D |
| Multi-agent execution in single command       | Each agent store is independent; use `--agent` flag             | Phase 3D                                   |
| Config-file approval presets                  | Over-engineered for v1                                          | Phase 4                                    |

---

## 11. Approval Ladder (Recommended Rollout)

### Phase 3C (this spec) — Manual Selection Only

- Operator runs `--dry-run`, reads plan, selects action IDs
- Tier 0 + Tier 1 only
- Always requires explicit `--execute` flag
- Always shows confirmation prompt (unless `--yes`)

### Phase 3D — Tier 2 Unlock + Review

- Add Tier 2 execution support behind `--execute` (same manual selection model)
- Add pre-execution index backup (snapshot `sessions.json` before mutation)
- Evaluate whether `--execute-tier 2` should exist or if Tier 2 should remain ID-only

### Phase 3E — Tier 3 + Safety Rails

- Add Tier 3 execution with mandatory pre-execution backup
- Add `--undo-last` for reversing the most recent execution
- Evaluate progressive rollout (execute 10% → verify → execute rest)

### Phase 4 — Selective Automation (if warranted)

- Config-file presets for Tier 0 auto-execution
- Scheduled runs with operator-defined scope
- Only after extensive production use proves safety

---

## 12. Implementation Scope Estimate

### New Files

- `src/infra/session-health-remediation-executor.ts` — core executor logic
- `src/infra/session-health-remediation-executor.test.ts` — executor tests
- `src/infra/session-health-file-discovery.ts` — shared file-discovery helpers (extracted from collector)
- `src/infra/session-health-file-discovery.test.ts` — discovery tests

### Modified Files

- `src/commands/sessions-cleanup.ts` — add `--execute`, `--execute-tier`, `--yes` flag handling
- `src/cli/program/register.status-health-sessions.ts` — register new flags
- `src/infra/session-health-remediation-types.ts` — add `ActionExecutionResult`, `ExecutionSummary` types

### Estimated Scope

- ~400–600 lines of new code (executor + file discovery)
- ~100–150 lines of CLI integration
- ~300–500 lines of tests
- Total: ~800–1250 lines

### Complexity: Medium

The hardest part is extracting file-discovery logic from the collector into reusable helpers. The executor itself is straightforward (delete files, rename files, report results). The CLI integration follows existing patterns.

---

## 13. Recommendation: Next Step

**Spec + immediate bounded implementation.**

The spec is tight enough to implement directly. The v1 scope is well-bounded (4 action executors, file discovery extraction, CLI flags, confirmation prompt, before/after reporting). There are no open design questions that need operator feedback before building.

Recommended implementation order:

1. Extract file-discovery helpers from collector
2. Build executor with 4 action executors
3. Wire CLI flags and confirmation prompt
4. Build before/after reporting
5. Test suite
6. Manual verification on a real session store

This is a single-worker job — no parallelism needed. Estimated implementation time: one focused session.
