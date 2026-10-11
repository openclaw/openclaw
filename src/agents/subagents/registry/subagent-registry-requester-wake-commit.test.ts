import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type { SubagentLifecycleWakeContext } from "./subagent-registry-lifecycle-context.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  REQUESTER_SETTLE_WAKE_PARKED_PROBE_INTERVAL_MS,
  retryPendingWakeCommit,
  shouldReportRequesterSettleWakeFailure,
} from "./subagent-registry-requester-wake-commit.js";
import { settleOrParkRequesterWake } from "./subagent-registry-requester-wake-park.js";
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

  describe("parked owner-changed settlement (#154252)", () => {
    const ownerChanged = () =>
      new Error("subagent completion owner changed before settlement: run-a");

    /** Mirrors the completeBatch caller: a non-delivered settle wrapped by the park policy. */
    async function openSettleEpisode(entry: SubagentRunRecord, settle: () => Promise<boolean>) {
      const { context } = makeContext(entry);
      const attempts = vi.fn(settle);
      await commitRequesterWake(
        context,
        [entry],
        undefined,
        (members, episode) => settleOrParkRequesterWake(context, episode, members, attempts),
        true,
      ).catch(() => undefined);
      return { context, attempts };
    }

    async function retryDue(
      context: SubagentLifecycleWakeContext,
      entry: SubagentRunRecord,
    ): Promise<void> {
      const pending = getPendingWakeCommit(context, entry)!;
      vi.setSystemTime(Math.max(Date.now(), pending.nextAttemptAt));
      await retryPendingWakeCommit(context, pending).catch(() => undefined);
    }

    it("defers a parked episode by the probe interval and keeps its wake retained", async () => {
      const entry = makeRetainedChild();
      const { context, attempts } = await openSettleEpisode(entry, async () => {
        throw ownerChanged();
      });
      for (let i = 0; i < 3; i += 1) {
        await retryDue(context, entry);
      }
      // Four rejections so far: still on the capped backoff.
      expect(getPendingWakeCommit(context, entry)?.parked).toBeFalsy();
      expect(getPendingWakeCommit(context, entry)!.nextAttemptAt - Date.now()).toBe(120_000);

      await retryDue(context, entry);

      const parked = getPendingWakeCommit(context, entry)!;
      expect(parked.parked).toBe(true);
      expect(attempts).toHaveBeenCalledTimes(5);
      expect(parked.nextAttemptAt - Date.now()).toBe(
        REQUESTER_SETTLE_WAKE_PARKED_PROBE_INTERVAL_MS,
      );
      // A sweeper resume before the deadline is gated; the probe runs once it is due.
      vi.setSystemTime(Date.now() + REQUESTER_SETTLE_WAKE_PARKED_PROBE_INTERVAL_MS - 1);
      await retryPendingWakeCommit(context, parked);
      expect(attempts).toHaveBeenCalledTimes(5);
      vi.setSystemTime(Date.now() + 1);
      await retryPendingWakeCommit(context, parked).catch(() => undefined);
      expect(attempts).toHaveBeenCalledTimes(6);
    });

    it("keeps the capped backoff for storage failures, however long they last", async () => {
      const entry = makeRetainedChild();
      const { context, attempts } = await openSettleEpisode(entry, async () => {
        throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" });
      });
      for (let i = 0; i < 30; i += 1) {
        await retryDue(context, entry);
      }

      const pending = getPendingWakeCommit(context, entry)!;
      expect(attempts).toHaveBeenCalledTimes(31);
      expect(pending.parked).toBeFalsy();
      expect(pending.nextAttemptAt - Date.now()).toBe(120_000);
    });

    it("clears the parked episode once a probe settles", async () => {
      const entry = makeRetainedChild();
      let healed = false;
      const { context } = await openSettleEpisode(entry, async () => {
        if (!healed) {
          throw ownerChanged();
        }
        return true;
      });
      for (let i = 0; i < 4; i += 1) {
        await retryDue(context, entry);
      }
      expect(getPendingWakeCommit(context, entry)?.parked).toBe(true);

      healed = true;
      await retryDue(context, entry);

      expect(getPendingWakeCommit(context, entry)).toBeUndefined();
    });

    it("does not count a transition episode that never enters the policy", async () => {
      const entry = makeRetainedChild();
      const { context } = makeContext(entry);
      const transition = vi.fn(() => {
        throw ownerChanged();
      });
      await commitRequesterWake(context, [entry], undefined, transition, true).catch(
        () => undefined,
      );
      for (let i = 0; i < 20; i += 1) {
        await retryDue(context, entry);
      }

      expect(transition.mock.calls.length).toBeGreaterThan(15);
      expect(getPendingWakeCommit(context, entry)?.parked).toBeUndefined();
      expect(getPendingWakeCommit(context, entry)?.ownerChangedFailures).toBeUndefined();
    });
  });
});
