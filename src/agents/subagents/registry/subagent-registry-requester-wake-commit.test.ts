import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  retryPendingWakeCommit,
  shouldReportRequesterSettleWakeFailure,
} from "./subagent-registry-requester-wake-commit.js";
import { createRequesterWakeContextFixture } from "./subagent-registry-requester-yield.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

function makeRetainedChild(runId = "run-a"): SubagentRunRecord {
  return {
    runId,
    childSessionKey: `agent:main:subagent:${runId}`,
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
    expectsCompletionMessage: true,
    delivery: { status: "pending" },
    requesterSettleWake: { status: "dispatching", attemptCount: 3 },
  };
}

function makeContext(entry = makeRetainedChild(), siblings: SubagentRunRecord[] = []) {
  const warn = vi.fn();
  const runs = new Map([entry, ...siblings].map((child) => [child.runId, child]));
  const context = createRequesterWakeContextFixture(runs, warn);
  return { entry, context, warn };
}

function makeDeferredCommit() {
  const started = createDeferredCore();
  const result = createDeferredCore<boolean>();
  const commit = vi.fn(() => {
    started.resolve();
    return result.promise;
  });
  return { commit, started: started.promise, release: result.resolve };
}

async function sweep(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  sweeps: number,
): Promise<void> {
  for (let pass = 0; pass < sweeps; pass += 1) {
    const pending = getPendingWakeCommit(context, entry);
    if (!pending) {
      return;
    }
    vi.setSystemTime(Math.max(Date.now(), pending.nextAttemptAt) + 1);
    await retryPendingWakeCommit(context, pending);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requester settle wake commit retry", () => {
  it.each([true, false])(
    "serializes overlapping wake episodes (first published: %s)",
    async (published) => {
      const { entry, context } = makeContext();
      const firstCommit = makeDeferredCommit();
      const secondCommit = vi.fn(() => true);
      const first = commitRequesterWake(context, [entry], undefined, firstCommit.commit, true);
      await firstCommit.started;
      const original = getPendingWakeCommit(context, entry);
      const second = commitRequesterWake(context, [entry], undefined, secondCommit, true);
      expect(getPendingWakeCommit(context, entry)).toBe(original);
      expect(secondCommit).not.toHaveBeenCalled();
      firstCommit.release(published);
      await Promise.all([first, second]);
      expect(firstCommit.commit).toHaveBeenCalledOnce();
      expect(secondCommit).toHaveBeenCalledTimes(published ? 1 : 0);
      expect(getPendingWakeCommit(context, entry)).toBe(published ? undefined : original);
    },
  );

  it("keeps a recovered Gateway wake separate from the retired callback", async () => {
    const { entry, context } = makeContext();
    const firstCommit = makeDeferredCommit();
    const oldWake = commitRequesterWake(context, [entry], undefined, firstCommit.commit, true);
    await firstCommit.started;
    const recovered = structuredClone(entry);
    context.options.runs.set(entry.runId, recovered);
    const secondCommit = makeDeferredCommit();
    const newWake = commitRequesterWake(context, [recovered], undefined, secondCommit.commit, true);
    try {
      await secondCommit.started;
      const successor = getPendingWakeCommit(context, recovered);
      expect(successor).toBeDefined();
      expect(getPendingWakeCommit(context, entry)).toBeUndefined();
      firstCommit.release(true);
      await oldWake;
      expect(getPendingWakeCommit(context, recovered)).toBe(successor);
      secondCommit.release(true);
      await newWake;
      expect(getPendingWakeCommit(context, recovered)).toBeUndefined();
    } finally {
      firstCommit.release(true);
      secondCommit.release(true);
      await Promise.allSettled([oldWake, newWake]);
    }
  });

  it("holds one settlement fence until the async write and its retry settle", async () => {
    const { entry, context } = makeContext();
    const firstWrite = makeDeferredCommit();
    const retryWrite = makeDeferredCommit();
    const commit = vi
      .fn()
      .mockImplementationOnce(firstWrite.commit)
      .mockImplementationOnce(retryWrite.commit);

    const initial = commitRequesterWake(context, [entry], undefined, commit, true);
    await firstWrite.started;
    const pending = getPendingWakeCommit(context, entry);
    expect(pending).toBeDefined();
    if (!pending) {
      throw new Error("Unsettled write lost its requester wake fence");
    }
    const sibling = retryPendingWakeCommit(context, pending);
    expect(commit).toHaveBeenCalledTimes(1);
    firstWrite.release(false);
    await Promise.all([initial, sibling]);
    expect(getPendingWakeCommit(context, entry)).toBe(pending);
    expect(pending.nextAttemptAt).toBeGreaterThan(Date.now());

    vi.setSystemTime(pending.nextAttemptAt);
    const retry = retryPendingWakeCommit(context, pending);
    await retryWrite.started;
    expect(getPendingWakeCommit(context, entry)).toBe(pending);
    const retrySibling = retryPendingWakeCommit(context, pending);
    expect(commit).toHaveBeenCalledTimes(2);
    retryWrite.release(true);
    await Promise.all([retry, retrySibling]);
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
  });

  it("retains a failed wake all day at the two-minute ceiling, then settles after recovery (#154252)", async () => {
    const { entry, context, warn } = makeContext();
    const before = structuredClone(entry);
    const wakeBefore = entry.requesterSettleWake;
    let writable = false;
    const commit = vi.fn(() => writable);
    await commitRequesterWake(context, [entry], undefined, commit, true);

    const until = Date.now() + 24 * 60 * 60_000;
    while (Date.now() < until) {
      const pending = getPendingWakeCommit(context, entry);
      if (!pending) {
        throw new Error("Failed write lost its requester wake");
      }
      expect(pending.nextAttemptAt).toBeGreaterThan(Date.now());
      expect(pending.nextAttemptAt - Date.now()).toBeLessThanOrEqual(120_000);
      vi.setSystemTime(Date.now() + 60_000);
      await retryPendingWakeCommit(context, pending);
    }
    expect(commit.mock.calls.length).toBeGreaterThan(700);
    expect(entry).toEqual(before);
    expect(entry.requesterSettleWake).toBe(wakeBefore);
    const sustained = warn.mock.calls.filter(
      ([message]) => message === "requester settle wake commit still failing; retries continue",
    );
    expect(sustained).toHaveLength(1);
    expect(sustained[0]?.[1]).toMatchObject({ runIds: expect.any(Array) });

    const attemptsWhileFailing = commit.mock.calls.length;
    writable = true;
    await sweep(context, entry, 5);
    expect(commit).toHaveBeenCalledTimes(attemptsWhileFailing + 1);
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
  });

  it("gives a genuinely new obligation its own budget", async () => {
    const { entry, context } = makeContext();

    await commitRequesterWake(context, [entry], undefined, () => false, true);
    await sweep(context, entry, 50);

    // A re-armed wake is a different obligation, so the old one releases.
    context.options.runs.set(
      entry.runId,
      copySubagentRunRuntimeOwner(entry, {
        ...entry,
        requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
      }),
    );
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();

    const nextCommit = vi.fn(() => true);
    await commitRequesterWake(
      context,
      [context.options.runs.get(entry.runId)!],
      1,
      nextCommit,
      true,
    );
    expect(nextCommit).toHaveBeenCalledOnce();
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
  });
});

const READONLY_FAULT = { name: "SqliteError", message: "attempt to write a readonly database" };
const MALFORMED_FAULT = { name: "SqliteError", message: "database disk image is malformed" };

describe("requester settle wake failure reporting", () => {
  it.each([
    { repeats: 1, reports: 1, suppressed: 0 },
    { repeats: 40, reports: 5, suppressed: 35 },
  ])(
    "reports new faults and accounts for $suppressed suppressed repeats on recovery",
    async ({ repeats, reports, suppressed }) => {
      const { entry, context, warn } = makeContext();
      expect(getPendingWakeCommit(context, entry)).toBeUndefined();
      expect(shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT)).toBe(true);

      let writable = false;
      await commitRequesterWake(context, [entry], undefined, () => writable, true);
      // Reporting, rather than another failed commit, spends the repeat budget.
      const decisions = Array.from({ length: repeats }, () =>
        shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT),
      );
      expect(decisions.filter(Boolean)).toHaveLength(reports);
      expect(decisions.slice(0, reports).every(Boolean)).toBe(true);
      expect(getPendingWakeCommit(context, entry)?.suppressedFailureLogs ?? 0).toBe(suppressed);
      expect(shouldReportRequesterSettleWakeFailure(context, entry, MALFORMED_FAULT)).toBe(true);
      expect(shouldReportRequesterSettleWakeFailure(context, entry, MALFORMED_FAULT)).toBe(true);

      writable = true;
      await sweep(context, entry, 5);
      expect(getPendingWakeCommit(context, entry)).toBeUndefined();
      const recovered = warn.mock.calls.filter(
        ([message]) => message === "requester settle wake commit recovered",
      );
      expect(recovered).toHaveLength(suppressed > 0 ? 1 : 0);
      if (suppressed > 0) {
        expect(recovered[0]?.[1]).toMatchObject({ suppressedFailureLogs: suppressed });
      }
    },
  );
});
