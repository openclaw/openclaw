import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import type {
  PendingRequesterSettleWakeCommit,
  SubagentLifecycleWakeContext,
} from "./subagent-registry-lifecycle-context.js";
import {
  commitRequesterWake,
  getPendingWakeCommit,
  retryPendingWakeCommit,
  shouldReportRequesterSettleWakeFailure,
} from "./subagent-registry-requester-wake-commit.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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

function makeContext(entries: readonly SubagentRunRecord[]): {
  context: SubagentLifecycleWakeContext;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  const runs = new Map(entries.map((entry) => [entry.runId, entry]));
  const context = {
    options: { runs, warn },
    pendingRequesterSettleWakeCommits: new WeakMap<
      SubagentRunRecord,
      PendingRequesterSettleWakeCommit
    >(),
    newerGenerationOwnsSession: () => false,
  } as unknown as SubagentLifecycleWakeContext;
  return { context, warn };
}

/**
 * Drives the real lifecycle retry seam as fast as its own deadlines allow:
 * every pass jumps to whatever deadline the previous failure set.
 */
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

/**
 * Walks wall-clock time in fixed ticks, retrying only once the deadline the
 * production code set has actually passed. That is what the lifecycle timer
 * does, so the attempt count this produces is an attempts-per-window figure.
 */
async function runForWindow(
  context: SubagentLifecycleWakeContext,
  entry: SubagentRunRecord,
  windowMs: number,
  tickMs: number,
): Promise<void> {
  const until = Date.now() + windowMs;
  while (Date.now() < until) {
    vi.setSystemTime(Date.now() + tickMs);
    const pending = getPendingWakeCommit(context, entry);
    if (!pending) {
      return;
    }
    await retryPendingWakeCommit(context, pending);
  }
}

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

describe("requester settle wake commit retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds one settlement fence until the async write and its retry settle", async () => {
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);
    const firstWrite = createDeferredCore<boolean>();
    const retryWrite = createDeferredCore<boolean>();
    const firstStarted = createDeferredCore();
    const retryStarted = createDeferredCore();
    const commit = vi
      .fn()
      .mockImplementationOnce(() => {
        firstStarted.resolve();
        return firstWrite.promise;
      })
      .mockImplementationOnce(() => {
        retryStarted.resolve();
        return retryWrite.promise;
      });

    const initial = commitRequesterWake(context, [entry], undefined, commit, true);
    await firstStarted.promise;
    const pending = getPendingWakeCommit(context, entry);
    expect(pending).toBeDefined();
    if (!pending) {
      throw new Error("Unsettled write lost its requester wake fence");
    }
    const sibling = retryPendingWakeCommit(context, pending);
    expect(commit).toHaveBeenCalledTimes(1);
    firstWrite.resolve(false);
    await Promise.all([initial, sibling]);
    expect(getPendingWakeCommit(context, entry)).toBe(pending);
    expect(pending.nextAttemptAt).toBeGreaterThan(Date.now());

    vi.setSystemTime(pending.nextAttemptAt);
    const retry = retryPendingWakeCommit(context, pending);
    await retryStarted.promise;
    expect(getPendingWakeCommit(context, entry)).toBe(pending);
    const retrySibling = retryPendingWakeCommit(context, pending);
    expect(commit).toHaveBeenCalledTimes(2);
    retryWrite.resolve(true);
    await Promise.all([retry, retrySibling]);
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
  });

  it("holds the retry ceiling at two minutes", async () => {
    // Regression for recovery latency: widening this ceiling to cut log volume
    // also postpones the write that would have succeeded, so the requester waits
    // out the whole gap after storage comes back. Reported volume is bounded by
    // shouldReportRequesterSettleWakeFailure instead.
    // https://github.com/openclaw/openclaw/issues/154252
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);

    await commitRequesterWake(context, [entry], undefined, () => false, true);
    let widestGapMs = 0;
    for (let pass = 0; pass < 50; pass += 1) {
      const pending = getPendingWakeCommit(context, entry);
      expect(pending).toBeDefined();
      widestGapMs = Math.max(widestGapMs, (pending?.nextAttemptAt ?? 0) - Date.now());
      vi.setSystemTime(Math.max(Date.now(), pending?.nextAttemptAt ?? 0) + 1);
      await retryPendingWakeCommit(context, pending as PendingRequesterSettleWakeCommit);
    }

    expect(widestGapMs).toBeLessThanOrEqual(120_000);
  });

  it("keeps retrying a rejected write at that cadence all day", async () => {
    // The attempts-per-day figure is the recovery guarantee: a settlement that
    // can only succeed once storage returns has to be reattempted often enough
    // that the requester settles promptly when it does.
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);
    const commit = vi.fn(() => false);

    await commitRequesterWake(context, [entry], undefined, commit, true);
    await runForWindow(context, entry, ONE_DAY_MS, 60_000);

    // A 120s ceiling yields about 720 attempts a day; a 1800s ceiling about 50.
    expect(commit.mock.calls.length).toBeGreaterThan(700);
  });

  it("keeps a future retry deadline so the lifecycle owner stays armed", async () => {
    // scheduleRequesterSettleWakeRetry skips any deadline that is not ahead of
    // now, so a deadline in the past strands the pending wake until restart.
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);

    await commitRequesterWake(context, [entry], undefined, () => false, true);
    for (let pass = 0; pass < 50; pass += 1) {
      const pending = getPendingWakeCommit(context, entry);
      expect(pending).toBeDefined();
      expect(pending?.nextAttemptAt).toBeGreaterThan(Date.now());
      vi.setSystemTime(Math.max(Date.now(), pending?.nextAttemptAt ?? 0) + 1);
      await retryPendingWakeCommit(context, pending as PendingRequesterSettleWakeCommit);
    }
  });

  it("settles the unchanged wake once the write starts succeeding again", async () => {
    // The failing write is transient storage, not a bad row. Sustained failure
    // must not cost the requester its settlement when storage comes back.
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);
    let writable = false;
    const commit = vi.fn(() => writable);

    await commitRequesterWake(context, [entry], undefined, commit, true);
    await sweep(context, entry, 10);
    expect(getPendingWakeCommit(context, entry)).toBeDefined();
    const attemptsWhileFailing = commit.mock.calls.length;
    expect(attemptsWhileFailing).toBeGreaterThan(5);

    writable = true;
    await sweep(context, entry, 5);

    expect(commit.mock.calls.length).toBeGreaterThan(attemptsWhileFailing);
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
  });

  it("reports one sustained failure per episode, with its run ids", async () => {
    const entry = makeRetainedChild();
    const { context, warn } = makeContext([entry]);

    await commitRequesterWake(context, [entry], undefined, () => false, true);
    await sweep(context, entry, 50);

    const sustained = warn.mock.calls.filter(
      ([message]) => message === "requester settle wake commit still failing; retries continue",
    );
    expect(sustained).toHaveLength(1);
    expect(sustained[0]?.[1]).toMatchObject({ runIds: expect.any(Array) });
  });

  it("leaves the wake on its row while the write keeps failing", async () => {
    // The durable write is the thing failing, so a failed settlement must not
    // try to record an outcome. Nothing captured may be discarded.
    const entry = makeRetainedChild();
    const wakeBefore = entry.requesterSettleWake;
    const { context } = makeContext([entry]);

    await commitRequesterWake(context, [entry], undefined, () => false, true);
    await sweep(context, entry, 50);

    expect(entry.requesterSettleWake).toBe(wakeBefore);
    expect(entry.requesterSettleWake).toMatchObject({
      status: "dispatching",
      attemptCount: 3,
    });
    expect(entry.delivery).toMatchObject({ status: "pending" });
  });

  it("keeps retrying while the write can still succeed", async () => {
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);
    let attempts = 0;
    const commit = vi.fn(() => {
      attempts += 1;
      return attempts >= 3;
    });

    await commitRequesterWake(context, [entry], undefined, commit, true);
    await sweep(context, entry, 50);

    expect(commit).toHaveBeenCalledTimes(3);
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
  });

  it("gives a genuinely new obligation its own budget", async () => {
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);

    await commitRequesterWake(context, [entry], undefined, () => false, true);
    await sweep(context, entry, 50);

    // A re-armed wake is a different obligation, so the old one releases.
    entry.requesterSettleWake = { status: "pending", attemptCount: 0 };
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();

    const nextCommit = vi.fn(() => true);
    await commitRequesterWake(context, [entry], undefined, nextCommit, true);
    expect(nextCommit).toHaveBeenCalledOnce();
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
  });
});

const READONLY_FAULT = { name: "SqliteError", message: "attempt to write a readonly database" };
const MALFORMED_FAULT = { name: "SqliteError", message: "database disk image is malformed" };

describe("requester settle wake failure reporting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Puts a live retry episode on the row without reporting anything yet. */
  async function openEpisode(writable = () => false): Promise<{
    context: SubagentLifecycleWakeContext;
    entry: SubagentRunRecord;
    warn: ReturnType<typeof vi.fn>;
  }> {
    const entry = makeRetainedChild();
    const { context, warn } = makeContext([entry]);
    await commitRequesterWake(context, [entry], undefined, writable, true);
    return { context, entry, warn };
  }

  it("reports a failure that no retry episode owns", () => {
    const entry = makeRetainedChild();
    const { context } = makeContext([entry]);

    // Nothing is pending, so this failure has nothing to repeat.
    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
    expect(shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT)).toBe(true);
  });

  it("spends a fixed budget on an identical repeat, then withholds it", async () => {
    // The budget is spent by reporting, so it is counted that way and holds
    // even when nothing advances the episode's commit failure count between
    // reports. Driving it without any intervening commit attempt is what pins
    // that down: a budget read off `failures` would not expire here.
    const { context, entry } = await openEpisode();

    const decisions: boolean[] = [];
    for (let attempt = 0; attempt < 40; attempt += 1) {
      decisions.push(shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT));
    }

    expect(decisions.filter(Boolean)).toHaveLength(5);
    expect(decisions.slice(0, 5).every(Boolean)).toBe(true);
    expect(getPendingWakeCommit(context, entry)?.suppressedFailureLogs).toBe(35);
  });

  it("always reports a fault other than the one already reported", async () => {
    const { context, entry } = await openEpisode();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT);
    }

    // A new failure mode must never sit hidden behind an older one.
    expect(shouldReportRequesterSettleWakeFailure(context, entry, MALFORMED_FAULT)).toBe(true);
    expect(shouldReportRequesterSettleWakeFailure(context, entry, MALFORMED_FAULT)).toBe(true);
  });

  it("accounts for the reports it withheld once the episode recovers", async () => {
    // A log that goes quiet must not read as an outage that stopped happening.
    let writable = false;
    const { context, entry, warn } = await openEpisode(() => writable);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT);
    }

    writable = true;
    await sweep(context, entry, 5);

    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
    const recovered = warn.mock.calls.filter(
      ([message]) => message === "requester settle wake commit recovered",
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.[1]).toMatchObject({ suppressedFailureLogs: 25 });
  });

  it("stays silent about recovery when it withheld nothing", async () => {
    let writable = false;
    const { context, entry, warn } = await openEpisode(() => writable);
    shouldReportRequesterSettleWakeFailure(context, entry, READONLY_FAULT);

    writable = true;
    await sweep(context, entry, 5);

    expect(getPendingWakeCommit(context, entry)).toBeUndefined();
    expect(
      warn.mock.calls.filter(([message]) => message === "requester settle wake commit recovered"),
    ).toHaveLength(0);
  });
});
