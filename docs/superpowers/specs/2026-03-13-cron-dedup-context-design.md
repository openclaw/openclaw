# Cron Dedup Context: Inject Previous Outputs Into Isolated Agent Turns

## Problem

Isolated cron sessions (`sessionTarget: "isolated"`) create a fresh transcript per run. The agent cannot see what it previously delivered, leading to repetitive outputs.

### Example

A cron job configured to send a daily celebrity briefing:

1. Run 1: "Today's celebrity news: Actor X attended Y event..."
2. Run 2: "Today's celebrity news: Actor X attended Y event..." (nearly identical)
3. Run 3: same pattern

The agent has no memory of prior outputs, so it cannot avoid repetition.

### Root Cause

- `forceNew: true` in `resolveCronSession()` creates a new session ID and empty transcript every run
- `CronJobState` only tracks `lastDelivered` (boolean), not the actual output text
- No mechanism exists to pass previous outputs to the cron agent

## Solution: Per-Job Output History in CronJobState

Store recent delivered outputs in `job.state.recentOutputs` and inject them into the agent's system prompt when the job opts in via `dedupContext: true`.

### Why This Approach

- **Simplest**: no new store, no new file I/O — reuses the existing cron store persistence
- **Lifecycle match**: output history belongs to the job; delete job = delete history
- **Already on the hot path**: cron store is loaded/saved every run cycle
- **Minimal overhead**: ~2.5KB per job worst case (5 entries x 500 chars)

## Components

### 1. Data Model Changes

**File**: `src/cron/types.ts`

Add to `CronJobState` (after line 133):

```typescript
export type CronJobState = {
  // ... existing fields ...

  /**
   * Recent delivered outputs for dedup context injection.
   * Capped at 5 entries, FIFO. Only populated when `payload.dedupContext` is enabled.
   */
  recentOutputs?: Array<{
    /** Delivered text, truncated to 500 characters. */
    text: string;
    /** Timestamp (ms since epoch) when the output was delivered. */
    timestamp: number;
  }>;
};
```

Add to `CronAgentTurnPayloadFields` (after line 100):

```typescript
export type CronAgentTurnPayloadFields = {
  // ... existing fields ...

  /**
   * When true, inject recent delivered outputs into the agent's system prompt
   * so it can avoid repeating the same content. Default: false.
   */
  dedupContext?: boolean;
};
```

**Constants** (in the implementation file, not the type file):

```typescript
const DEDUP_MAX_OUTPUTS = 5;
const DEDUP_MAX_CHARS_PER_OUTPUT = 500;
```

### 2. Recording Point

**Strategy:** Reuse the existing `outputText` field on `RunCronAgentTurnResult` rather than adding a new field. `outputText` already represents the last non-empty agent text output, flows through the result chain, and reflects subagent final replies when applicable.

The result chain is: `dispatchCronDelivery()` → `runCronIsolatedAgentTurn()` → `runIsolatedAgentJob()` → `executeJobCore()` → `applyJobResult()`.

Currently `outputText` is available on `RunCronAgentTurnResult` and `runIsolatedAgentJob`'s return type, but is dropped by `executeJobCore()` which maps to a narrower `TimedCronRunOutcome`. We need to thread it through.

**File**: `src/cron/service/timer.ts`

1. Add `outputText?: string` to `TimedCronRunOutcome` (line ~46).

2. In `executeJobCore()` (line ~1143), include `outputText` in the returned object from the `runIsolatedAgentJob` result.

3. In `applyOutcomeToStoredJob()` (line ~491), pass `outputText` through to `applyJobResult`.

4. In `applyJobResult()` (line 295), extend the `result` parameter type and add recording logic:

```typescript
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    // ... existing fields ...
    outputText?: string;
  },
  // ...
): boolean {
```

After the existing state updates (after line 335), add:

```typescript
// Record delivered output for dedup context (only when enabled and delivered).
if (
  result.delivered &&
  result.outputText?.trim() &&
  job.payload.kind === "agentTurn" &&
  job.payload.dedupContext
) {
  const outputs = job.state.recentOutputs ?? [];
  outputs.push({
    text: result.outputText.slice(0, DEDUP_MAX_CHARS_PER_OUTPUT),
    timestamp: result.endedAt,
  });
  if (outputs.length > DEDUP_MAX_OUTPUTS) {
    outputs.splice(0, outputs.length - DEDUP_MAX_OUTPUTS);
  }
  job.state.recentOutputs = outputs;
}
```

5. The `executeJob()` forced-execution path (line ~1161) also calls `applyJobResult` — ensure `outputText` is threaded through this path as well.

### 3. Injection Point

**File**: `src/cron/isolated-agent/run.ts`

The system prompt assembly in `run.ts` (lines 441-480) builds a `base` string, then branches into external-hook vs. internal paths, and finally calls `appendCronDeliveryInstruction()` at line 480 to produce `commandBody`. The dedup block should be appended **after** `commandBody` is finalized (after line 480), so it doesn't get overwritten by the branching logic:

```typescript
commandBody = appendCronDeliveryInstruction({ commandBody, deliveryRequested });

// ──── INSERT HERE ────
const dedupBlock = buildDedupContextBlock(params.job);
if (dedupBlock) {
  commandBody = `${commandBody}\n\n${dedupBlock}`;
}
```

**Helper function** (new, in the same file or a small helper):

```typescript
function buildDedupContextBlock(job: CronJob): string | undefined {
  if (job.payload.kind !== "agentTurn" || !job.payload.dedupContext) {
    return undefined;
  }
  const outputs = job.state.recentOutputs;
  if (!outputs || outputs.length === 0) {
    return undefined;
  }

  const tz = job.schedule.kind === "cron" ? job.schedule.tz : undefined;
  const lines = outputs.map((o) => {
    const date = new Date(o.timestamp);
    const formatted = tz
      ? date.toLocaleString("en-US", { timeZone: tz, dateStyle: "short", timeStyle: "short" })
      : date.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });
    return `- ${formatted}: ${o.text}`;
  });

  return [
    "[Your previous outputs for this scheduled task — avoid repeating the same content:]",
    ...lines,
  ].join("\n");
}
```

## Data Flow

```
Cron Job Run (isolated session)
  │
  ▼
  buildDedupContextBlock(job)
  → reads job.state.recentOutputs
  → appends to agent system prompt (if dedupContext=true and outputs exist)
  │
  ▼
  Agent turn executes with dedup context
  → produces new, non-repetitive output
  │
  ▼
  dispatchCronDelivery()
  → delivers to channel
  → outputText reflects final delivered text (including subagent replacements)
  │
  ▼
  runCronIsolatedAgentTurn() → runIsolatedAgentJob() → executeJobCore()
  → outputText threaded through result chain
  │
  ▼
  applyJobResult()
  → pushes { text: outputText, timestamp } to job.state.recentOutputs (capped at 5)
  → saves cron store
  │
  ▼
  Next run reads updated recentOutputs
```

## Edge Cases

| Scenario                         | Behavior                                                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `dedupContext` not set (default) | No recording, no injection. Zero overhead.                                                                                                   |
| First run (no previous outputs)  | No dedup block injected. Agent runs normally.                                                                                                |
| Job delivery fails               | `result.delivered` is false; output NOT recorded (no false history).                                                                         |
| Output exceeds 500 chars         | Truncated at 500 chars before storage.                                                                                                       |
| 6th output arrives               | Oldest entry dropped (FIFO).                                                                                                                 |
| Job disabled then re-enabled     | `recentOutputs` persists in job state; history survives.                                                                                     |
| Job deleted                      | State deleted with job. No orphan cleanup.                                                                                                   |
| Non-agentTurn payload            | Guard: `job.payload.kind === "agentTurn"` skips non-agent payloads.                                                                          |
| Subagent orchestration           | `outputText` is updated to the subagent final reply (lines 366-377 in dispatch); that final text is what gets recorded via the result chain. |

## Changes Summary

| File                                                 | Change                                                                                                                                       | Estimated Lines |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `src/cron/types.ts`                                  | Add `recentOutputs` to state, `dedupContext` to payload                                                                                      | +12             |
| `src/cron/isolated-agent/run.ts`                     | Inject dedup block after `commandBody`, add `buildDedupContextBlock` helper                                                                  | +30             |
| `src/cron/service/timer.ts`                          | Thread `outputText` through `TimedCronRunOutcome`, `executeJobCore`, `executeJob`, `applyOutcomeToStoredJob`, and record in `applyJobResult` | +25             |
| `src/cron/isolated-agent/run.test.ts` (or colocated) | Unit tests for `buildDedupContextBlock`                                                                                                      | +40             |
| `src/cron/service/timer.test.ts` (or colocated)      | Unit tests for recording in `applyJobResult`                                                                                                 | +30             |

Total: ~140 lines of new code across 3 existing files. No new files needed.
