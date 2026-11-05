import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearSessionGoal,
  createSessionGoal,
  updateSessionGoalObjective,
  updateSessionGoalStatus,
} from "../../config/sessions/goals.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { preparedSharingReads } from "../../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import { bindHostNativeGoal, withRequiredHostGoal } from "./host-native-goal.js";

describe("admitted native goal projection", () => {
  const fixture = useTempSessionsFixture("openclaw-native-goal-");
  const target = () => ({
    agentId: "main",
    sessionKey: "agent:main:native-goal",
    sessionId: "native-goal-session",
    storePath: fixture.storePath(),
    expectedLifecycleRevision: "generation-1",
  });
  const read = () => loadSessionEntry(target())!;
  const owners: AbortController[] = [];
  const subscriptions = () =>
    [...preparedSharingReads]
      .filter(([key]) => key.endsWith(`\0${target().sessionKey}`))
      .reduce((count, [, reads]) => count + reads.size, 0);
  afterEach(() => {
    for (const owner of owners.splice(0)) {
      owner.abort();
    }
    expect(subscriptions()).toBe(0);
  });
  async function start(assertCurrent = () => {}, owner = new AbortController()) {
    owners.push(owner);
    await upsertSessionEntryCore(target(), {
      sessionId: target().sessionId,
      lifecycleRevision: "generation-1",
      updatedAt: 1,
      totalTokens: 10,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
    await createSessionGoal({
      ...target(),
      objective: "Finish and verify the deliverable",
      tokenBudget: 100,
    });
    return bindHostNativeGoal(target(), assertCurrent, owner.signal);
  }

  it("shares the acquired owner with native projection through event settlement", async () => {
    let guard = () => {};
    await start(() => guard());
    let release = () => {};
    let native: Awaited<ReturnType<ReturnType<typeof bindHostNativeGoal>>>;
    try {
      await withRequiredHostGoal({
        target: target(),
        identity: {
          sessionId: target().sessionId,
          lifecycleRevision: "generation-1",
          goalId: read().goal!.id,
        },
        assertCurrent: () => guard(),
        onAcquired: (assertCurrent, close) => {
          guard = assertCurrent;
          release = close;
        },
        onRevoked: vi.fn(),
        run: async () => {
          expect(subscriptions()).toBe(1);
          const attempt = new AbortController();
          native = await bindHostNativeGoal(target(), () => guard(), attempt.signal)();
          expect(subscriptions()).toBe(1);
          await native!.onStatus({ status: "complete" });
          guard();
          expect(native!.signal.aborted).toBe(false);
          expect(subscriptions()).toBe(0);
        },
      });
      // Execution returning is not event settlement; final delivery still owns this fence.
      guard();
      expect(native!.signal.aborted).toBe(false);
    } finally {
      release();
    }
    expect(() => guard()).toThrow();
    expect(native!.signal.aborted).toBe(true);
  });

  it("rejects the wrong required Goal before transferring any receipt", async () => {
    await start();
    const acquired = vi.fn();
    const run = vi.fn();
    await expect(
      withRequiredHostGoal({
        target: target(),
        identity: {
          sessionId: target().sessionId,
          lifecycleRevision: "generation-1",
          goalId: "other-goal",
        },
        assertCurrent: () => {},
        onAcquired: acquired,
        onRevoked: vi.fn(),
        run,
      }),
    ).rejects.toThrow("lost its active Goal");
    expect(acquired).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(subscriptions()).toBe(0);
  });

  it.each(["complete", "blocked", "paused"] as const)(
    "projects native %s without cancelling its own successful write",
    async (status) => {
      const prepare = await start();
      const original = read().goal!;
      const goal = (await prepare())!;
      expect(goal).toMatchObject({
        version: 1,
        id: original.id,
        objective: original.objective,
        tokenBudget: 100,
      });
      const abort = vi.fn();
      goal.signal.addEventListener("abort", abort);
      await goal.onStatus({
        status,
        reason: "The native evaluator reported its verdict.",
      });
      expect(abort).not.toHaveBeenCalled();
      expect(goal.signal.aborted).toBe(false);
      expect(subscriptions()).toBe(0);
      await expect(goal.onStatus({ status: "complete" })).rejects.toThrow();
      expect(read().goal).toMatchObject({
        id: original.id,
        status,
        lastStatusNote: "The native evaluator reported its verdict.",
      });
    },
  );

  it.each(["paused", "blocked", "complete"] as const)(
    "never overwrites a newer host %s verdict",
    async (status) => {
      const goal = (await (await start())())!;
      await updateSessionGoalStatus({ ...target(), status, note: "newer host decision" });
      expect(goal.signal.aborted).toBe(true);
      await expect(
        goal.onStatus({ status: "complete", reason: "late native result" }),
      ).rejects.toThrow();
      expect(read().goal).toMatchObject({ status, lastStatusNote: "newer host decision" });
    },
  );

  it.each(["goal", "session", "source"] as const)(
    "rejects a retained verdict after %s authority changes",
    async (change) => {
      let active = true;
      const goal = (await (
        await start(() => {
          if (!active) {
            throw new Error("source retired");
          }
        })
      )())!;
      if (change === "goal") {
        await updateSessionGoalObjective({ ...target(), objective: "A different deliverable" });
      }
      if (change === "session") {
        await upsertSessionEntryCore(target(), { ...read(), lifecycleRevision: "generation-2" });
      }
      if (change === "source") {
        active = false;
      } else {
        expect(goal.signal.aborted).toBe(true);
      }
      await expect(goal.onStatus({ status: "complete" })).rejects.toThrow();
      expect(read().goal?.status).toBe("active");
    },
  );

  it.each(["clear", "replace", "id", "budget", "session", "lifecycle", "stop"] as const)(
    "aborts immediately on committed %s without waiting for a native callback",
    async (change) => {
      const goal = (await (await start())())!;
      const abort = vi.fn();
      goal.signal.addEventListener("abort", abort);
      if (change === "clear" || change === "replace") {
        await clearSessionGoal(target());
      }
      if (change === "replace") {
        await createSessionGoal({ ...target(), objective: goal.objective });
      }
      if (change === "id") {
        await upsertSessionEntryCore(target(), {
          ...read(),
          goal: { ...read().goal!, id: "replacement-goal" },
        });
      }
      if (change === "budget") {
        await upsertSessionEntryCore(target(), {
          ...read(),
          goal: { ...read().goal!, tokenBudget: 200 },
        });
      }
      if (change === "session") {
        await upsertSessionEntryCore(target(), { ...read(), sessionId: "replacement" });
      }
      if (change === "lifecycle") {
        await upsertSessionEntryCore(target(), { ...read(), lifecycleRevision: "generation-2" });
      }
      if (change === "stop") {
        await upsertSessionEntryCore(target(), { ...read(), abortedLastRun: true });
      }
      expect(abort).toHaveBeenCalledTimes(1);
      expect(goal.signal.aborted).toBe(true);
      expect(subscriptions()).toBe(0);
      const current = read();
      expect(() => goal.assertCurrent()).toThrow();
      await expect(goal.onStatus({ status: "complete" })).rejects.toThrow();
      expect(read()).toEqual(current);
    },
  );

  it("does not revive old native custody after Pause then Resume", async () => {
    const goal = (await (await start())())!;
    await updateSessionGoalStatus({ ...target(), status: "paused" });
    await updateSessionGoalStatus({ ...target(), status: "active" });
    expect(goal.signal.aborted).toBe(true);
    expect(() => goal.assertCurrent()).toThrow();
    await expect(goal.onStatus({ status: "complete" })).rejects.toThrow();
    expect(read().goal?.status).toBe("active");
  });

  it("ignores token accounting and unrelated metadata, checking retained facts without host SQL", async () => {
    const goal = (await (await start())())!;
    await upsertSessionEntryCore(target(), {
      ...read(),
      updatedAt: Date.now(),
      totalTokens: 15,
      goal: { ...read().goal!, tokensUsed: 5, updatedAt: Date.now() },
    });
    const sql = observeHostDataSql();
    try {
      goal.assertCurrent();
      expect(goal.signal.aborted).toBe(false);
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    await goal.onStatus({ status: "complete" });
    expect(goal.signal.aborted).toBe(false);
  });

  it("releases the committed-row observer and rejects retained callbacks when the owner closes", async () => {
    const owner = new AbortController();
    const prepare = await start(() => {}, owner);
    const goal = (await prepare())!;
    expect(await prepare()).toBe(goal);
    expect(subscriptions()).toBe(1);
    const reason = new Error("host capability closed");
    owner.abort(reason);
    expect(goal.signal.reason).toBe(reason);
    expect(subscriptions()).toBe(0);
    expect(() => goal.assertCurrent()).toThrow();
    await expect(goal.onStatus({ status: "complete" })).rejects.toThrow();
    expect(read().goal?.status).toBe("active");
  });

  it("does not subscribe after its lending run has already ended", async () => {
    const owner = new AbortController();
    const prepare = await start(() => {}, owner);
    owner.abort(new Error("run ended"));
    expect(() => prepare()).toThrow("run ended");
    expect(subscriptions()).toBe(0);
  });

  it("releases preparation custody when the owner ends during the asynchronous read", async () => {
    const owner = new AbortController();
    const prepare = await start(() => {}, owner);
    const pending = prepare();
    owner.abort(new Error("ended during preparation"));
    await expect(pending).rejects.toThrow();
    expect(subscriptions()).toBe(0);
  });

  it("does not retain a subscription for a session with no goal", async () => {
    const prepare = await start();
    await clearSessionGoal(target());
    expect(await prepare()).toBeUndefined();
    expect(subscriptions()).toBe(0);
  });

  it("does not supply native custody for a stopped goal", async () => {
    const prepare = await start();
    await updateSessionGoalStatus({ ...target(), status: "paused" });
    expect(await prepare()).toBeUndefined();
  });
});
