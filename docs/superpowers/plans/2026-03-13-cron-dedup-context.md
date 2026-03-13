# Cron Dedup Context Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject previous delivery outputs into isolated cron agent prompts so they can avoid repeating themselves.

**Architecture:** Store recent outputs in `CronJobState.recentOutputs` (capped FIFO array). Thread `outputText` through the timer result chain to `applyJobResult` for recording. Inject a dedup context block into `commandBody` before the agent turn when `payload.dedupContext` is enabled.

**Tech Stack:** TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-03-13-cron-dedup-context-design.md`

---

## File Structure

| File                                               | Responsibility                                        | Action                                                                   |
| -------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/cron/types.ts`                                | Type definitions for cron jobs                        | Modify: add `recentOutputs` to `CronJobState`, `dedupContext` to payload |
| `src/cron/isolated-agent/run.ts`                   | Isolated agent turn orchestration                     | Modify: inject dedup block into `commandBody`                            |
| `src/cron/service/timer.ts`                        | Job execution and state management                    | Modify: thread `outputText`, record in `applyJobResult`                  |
| `src/cron/isolated-agent/dedup-context.ts`         | Pure helper for building dedup prompt block           | Create                                                                   |
| `src/cron/isolated-agent/dedup-context.test.ts`    | Tests for dedup context builder                       | Create                                                                   |
| `src/cron/service.dedup-context-recording.test.ts` | Integration test for output recording via CronService | Create                                                                   |

---

## Chunk 1: All Tasks

### Task 1: Data Model — Add types

**Files:**

- Modify: `src/cron/types.ts:85-100` (CronAgentTurnPayloadFields)
- Modify: `src/cron/types.ts:109-133` (CronJobState)

- [ ] **Step 1: Add `dedupContext` to `CronAgentTurnPayloadFields`**

In `src/cron/types.ts`, add after the `bestEffortDeliver` field (line ~100):

```typescript
  /**
   * When true, inject recent delivered outputs into the agent's system prompt
   * so it can avoid repeating the same content. Default: false.
   */
  dedupContext?: boolean;
```

- [ ] **Step 2: Add `recentOutputs` to `CronJobState`**

In `src/cron/types.ts`, add after the `lastDelivered` field (line ~132):

```typescript
  /**
   * Recent delivered outputs for dedup context injection.
   * Capped at {@link DEDUP_MAX_OUTPUTS} entries, FIFO.
   * Only populated when `payload.dedupContext` is enabled.
   */
  recentOutputs?: Array<{
    /** Delivered text, truncated to {@link DEDUP_MAX_CHARS_PER_OUTPUT} characters. */
    text: string;
    /** Timestamp (ms since epoch) when the output was delivered. */
    timestamp: number;
  }>;
```

- [ ] **Step 3: Verify types compile**

Run: `pnpm tsgo`
Expected: No new errors

- [ ] **Step 4: Commit**

```bash
scripts/committer "feat(cron): add dedupContext and recentOutputs type definitions" src/cron/types.ts
```

---

### Task 2: Dedup Context Builder — Pure helper with tests

**Files:**

- Create: `src/cron/isolated-agent/dedup-context.ts`
- Create: `src/cron/isolated-agent/dedup-context.test.ts`

- [ ] **Step 1: Write failing tests for `buildDedupContextBlock`**

Create `src/cron/isolated-agent/dedup-context.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { buildDedupContextBlock } from "./dedup-context.js";
import type { CronJob } from "../types.js";

function makeJob(overrides?: {
  dedupContext?: boolean;
  recentOutputs?: Array<{ text: string; timestamp: number }>;
  tz?: string;
}): CronJob {
  return {
    id: "job-1",
    name: "test-job",
    description: "",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    schedule: {
      kind: "cron",
      expr: "0 8 * * *",
      ...(overrides?.tz ? { tz: overrides.tz } : {}),
    },
    payload: {
      kind: "agentTurn",
      message: "test",
      ...(overrides?.dedupContext ? { dedupContext: true } : {}),
    },
    delivery: { mode: "none" },
    state: {
      ...(overrides?.recentOutputs ? { recentOutputs: overrides.recentOutputs } : {}),
    },
  } as CronJob;
}

describe("buildDedupContextBlock", () => {
  it("returns undefined when dedupContext is not enabled", () => {
    const job = makeJob({ recentOutputs: [{ text: "hello", timestamp: 1000 }] });
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("returns undefined when dedupContext is enabled but no outputs exist", () => {
    const job = makeJob({ dedupContext: true });
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("returns undefined when recentOutputs is empty array", () => {
    const job = makeJob({ dedupContext: true, recentOutputs: [] });
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("returns undefined for non-agentTurn payload", () => {
    const job = makeJob({ dedupContext: true, recentOutputs: [{ text: "hi", timestamp: 1000 }] });
    (job.payload as { kind: string }).kind = "systemEvent";
    expect(buildDedupContextBlock(job)).toBeUndefined();
  });

  it("builds context block with formatted outputs", () => {
    const job = makeJob({
      dedupContext: true,
      recentOutputs: [
        { text: "First output", timestamp: 1710230400000 },
        { text: "Second output", timestamp: 1710316800000 },
      ],
    });
    const result = buildDedupContextBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("[Your previous outputs for this scheduled task");
    expect(result).toContain("First output");
    expect(result).toContain("Second output");
    // Second output should appear after first (chronological order preserved)
    const firstIdx = result!.indexOf("First output");
    const secondIdx = result!.indexOf("Second output");
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it("uses job timezone for formatting when available", () => {
    const job = makeJob({
      dedupContext: true,
      tz: "Asia/Shanghai",
      recentOutputs: [{ text: "output", timestamp: 1710230400000 }],
    });
    const result = buildDedupContextBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("output");
  });

  it("works with every-schedule jobs (no tz field)", () => {
    const job = makeJob({
      dedupContext: true,
      recentOutputs: [{ text: "output", timestamp: 1710230400000 }],
    });
    job.schedule = { kind: "every", everyMs: 60_000 };
    const result = buildDedupContextBlock(job);
    expect(result).toBeDefined();
    expect(result).toContain("output");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/cron/isolated-agent/dedup-context.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `buildDedupContextBlock`**

Create `src/cron/isolated-agent/dedup-context.ts`:

```typescript
import type { CronJob } from "../types.js";

export const DEDUP_MAX_OUTPUTS = 5;
export const DEDUP_MAX_CHARS_PER_OUTPUT = 500;

export function buildDedupContextBlock(job: CronJob): string | undefined {
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/cron/isolated-agent/dedup-context.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(cron): add buildDedupContextBlock helper with tests" src/cron/isolated-agent/dedup-context.ts src/cron/isolated-agent/dedup-context.test.ts
```

---

### Task 3: Injection Point — Append dedup block to commandBody

**Files:**

- Modify: `src/cron/isolated-agent/run.ts:480` (after `appendCronDeliveryInstruction`)

- [ ] **Step 1: Add import**

At the top of `src/cron/isolated-agent/run.ts`, add:

```typescript
import { buildDedupContextBlock } from "./dedup-context.js";
```

- [ ] **Step 2: Inject dedup block after commandBody finalization**

Find this line in `run.ts` (line ~480):

```typescript
commandBody = appendCronDeliveryInstruction({ commandBody, deliveryRequested });
```

Immediately after it, add:

```typescript
const dedupBlock = buildDedupContextBlock(params.job);
if (dedupBlock) {
  commandBody = `${commandBody}\n\n${dedupBlock}`;
}
```

- [ ] **Step 3: Verify types compile**

Run: `pnpm tsgo`
Expected: No new errors

- [ ] **Step 4: Run existing cron tests to check for regressions**

Run: `pnpm test src/cron/isolated-agent/`
Expected: All existing tests PASS (dedup block is only injected when `dedupContext=true`, which no existing test sets)

- [ ] **Step 5: Commit**

```bash
scripts/committer "feat(cron): inject dedup context block into agent prompt" src/cron/isolated-agent/run.ts
```

---

### Task 4: Thread outputText through timer result chain

**Files:**

- Modify: `src/cron/service/timer.ts:46-53` (TimedCronRunOutcome)
- Modify: `src/cron/service/timer.ts:1143-1154` (executeJobCore return)
- Modify: `src/cron/service/timer.ts:493-498` (applyOutcomeToStoredJob)
- Modify: `src/cron/service/timer.ts:1187-1192` (executeJob)

- [ ] **Step 1: Add `outputText` to `TimedCronRunOutcome`**

In `src/cron/service/timer.ts`, find (line ~46):

```typescript
type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
    startedAt: number;
    endedAt: number;
  };
```

Add `outputText?: string;` after `deliveryAttempted`:

```typescript
type TimedCronRunOutcome = CronRunOutcome &
  CronRunTelemetry & {
    jobId: string;
    delivered?: boolean;
    deliveryAttempted?: boolean;
    outputText?: string;
    startedAt: number;
    endedAt: number;
  };
```

- [ ] **Step 2: Include `outputText` in `executeJobCore` return**

In `src/cron/service/timer.ts`, find the return statement in `executeJobCore` after the `runIsolatedAgentJob` call (line ~1143). The current code explicitly lists fields from `res`. Add `outputText`:

```typescript
return {
  status: res.status,
  error: res.error,
  summary: res.summary,
  delivered: res.delivered,
  deliveryAttempted: res.deliveryAttempted,
  outputText: res.outputText,
  sessionId: res.sessionId,
  sessionKey: res.sessionKey,
  model: res.model,
  provider: res.provider,
  usage: res.usage,
};
```

- [ ] **Step 3: Pass `outputText` in `applyOutcomeToStoredJob`**

In `src/cron/service/timer.ts`, find `applyOutcomeToStoredJob` (line ~493). The call to `applyJobResult` currently passes:

```typescript
const shouldDelete = applyJobResult(state, job, {
  status: result.status,
  error: result.error,
  delivered: result.delivered,
  startedAt: result.startedAt,
  endedAt: result.endedAt,
});
```

Add `outputText`:

```typescript
const shouldDelete = applyJobResult(state, job, {
  status: result.status,
  error: result.error,
  delivered: result.delivered,
  outputText: result.outputText,
  startedAt: result.startedAt,
  endedAt: result.endedAt,
});
```

- [ ] **Step 4: Add `outputText` to `coreResult` inline type and pass it in `executeJob`**

In `src/cron/service/timer.ts`, find `executeJob` (line ~1161). The `coreResult` variable has an explicit inline type annotation (line ~1175):

```typescript
let coreResult: {
  status: CronRunStatus;
  delivered?: boolean;
} & CronRunOutcome &
  CronRunTelemetry;
```

Add `outputText?: string;` to the inline type:

```typescript
let coreResult: {
  status: CronRunStatus;
  delivered?: boolean;
  outputText?: string;
} & CronRunOutcome &
  CronRunTelemetry;
```

Then find the `applyJobResult` call in the same function (line ~1187). Add `outputText`:

```typescript
const shouldDelete = applyJobResult(state, job, {
  status: coreResult.status,
  error: coreResult.error,
  delivered: coreResult.delivered,
  outputText: coreResult.outputText,
  startedAt,
  endedAt,
});
```

- [ ] **Step 5: Verify types compile**

Run: `pnpm tsgo`
Expected: No new errors

- [ ] **Step 6: Run existing service tests for regressions**

Run: `pnpm test src/cron/service.persists-delivered-status.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
scripts/committer "feat(cron): thread outputText through timer result chain" src/cron/service/timer.ts
```

---

### Task 5: Recording — Store output in `applyJobResult`

**Files:**

- Modify: `src/cron/service/timer.ts:295-335` (applyJobResult)
- Create: `src/cron/service.dedup-context-recording.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `src/cron/service.dedup-context-recording.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

function buildDedupJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test", dedupContext: true },
    delivery: { mode: "none" },
  };
}

describe("CronService dedup context recording", () => {
  it("records outputText in recentOutputs when dedupContext is enabled and delivered", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: "Today's celebrity news: Actor X did Y",
        delivered: true,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("dedup-record"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toBeDefined();
      expect(updated?.state.recentOutputs).toHaveLength(1);
      expect(updated?.state.recentOutputs![0].text).toBe("Today's celebrity news: Actor X did Y");
      expect(updated?.state.recentOutputs![0].timestamp).toBeGreaterThan(0);
    } finally {
      cron.stop();
    }
  });

  it("does not record when dedupContext is not enabled", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: "some output",
        delivered: true,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add({
        ...buildDedupJob("no-dedup"),
        payload: { kind: "agentTurn", message: "test" },
      });
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("does not record when delivery fails", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: "some output",
        delivered: false,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("no-delivery"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toBeUndefined();
    } finally {
      cron.stop();
    }
  });

  it("caps recentOutputs at 5 entries (FIFO)", async () => {
    const store = await makeStorePath();
    let runCount = 0;
    const finished = createFinishedBarrier();
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        runCount++;
        return {
          status: "ok" as const,
          summary: "done",
          outputText: `output-${runCount}`,
          delivered: true,
        };
      }),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("cap-test"));

      // Run 6 times — waitForOk clears the internal resolver after resolution,
      // so calling it again re-registers for the next finished event.
      for (let i = 0; i < 6; i++) {
        vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
        await vi.runOnlyPendingTimersAsync();
        await finished.waitForOk(job.id);
        // Re-read job state for next iteration's nextRunAtMs
        const jobs = await cron.list({ includeDisabled: true });
        const updated = jobs.find((j) => j.id === job.id)!;
        Object.assign(job.state, updated.state);
      }

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs).toHaveLength(5);
      // Oldest (output-1) should be dropped, newest 5 remain
      expect(updated?.state.recentOutputs![0].text).toBe("output-2");
      expect(updated?.state.recentOutputs![4].text).toBe("output-6");
    } finally {
      cron.stop();
    }
  });

  it("truncates output text at 500 characters", async () => {
    const store = await makeStorePath();
    const finished = createFinishedBarrier();
    const longText = "x".repeat(600);
    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        outputText: longText,
        delivered: true,
      })),
      onEvent: (evt) => finished.onEvent(evt),
    });

    await cron.start();
    try {
      const job = await cron.add(buildDedupJob("truncate-test"));
      vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
      await vi.runOnlyPendingTimersAsync();
      await finished.waitForOk(job.id);

      const jobs = await cron.list({ includeDisabled: true });
      const updated = jobs.find((j) => j.id === job.id);
      expect(updated?.state.recentOutputs![0].text).toHaveLength(500);
    } finally {
      cron.stop();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/cron/service.dedup-context-recording.test.ts`
Expected: FAIL — `recentOutputs` is undefined (recording logic not yet implemented)

- [ ] **Step 3: Add `outputText` to `applyJobResult` parameter type and recording logic**

In `src/cron/service/timer.ts`, find `applyJobResult` (line 295). Add import at the top of the file:

```typescript
import { DEDUP_MAX_OUTPUTS, DEDUP_MAX_CHARS_PER_OUTPUT } from "../isolated-agent/dedup-context.js";
```

Extend the `result` parameter type to include `outputText`:

```typescript
export function applyJobResult(
  state: CronServiceState,
  job: CronJob,
  result: {
    status: CronRunStatus;
    error?: string;
    delivered?: boolean;
    outputText?: string;
    startedAt: number;
    endedAt: number;
  },
  // ...
```

After the existing `job.updatedAtMs = result.endedAt;` line (line ~335), add:

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

- [ ] **Step 4: Run the new tests to verify they pass**

Run: `pnpm test src/cron/service.dedup-context-recording.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Run full cron test suite for regressions**

Run: `pnpm test src/cron/`
Expected: All PASS

- [ ] **Step 6: Verify types compile**

Run: `pnpm tsgo`
Expected: No new errors

- [ ] **Step 7: Commit**

```bash
scripts/committer "feat(cron): record delivered output for dedup context" src/cron/service/timer.ts src/cron/service.dedup-context-recording.test.ts
```
