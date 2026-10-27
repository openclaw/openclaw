import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  clearAgentRunContext,
  registerAgentRunContext,
} from "../../../infra/agent-run-registry.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { beginSessionEffect } from "../../../sessions/session-controller.lifecycle.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { restartRecoveryTestHarness } from "./subagent-registry-restart-recovery.test-support.js";
import { createSubagentSweeperHarness } from "./subagent-registry-sweeper.test-support.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

const { mocks, childSessionKey, gatewayRuntime, dispatchAgent, run, recover } =
  restartRecoveryTestHarness;

type UnverifiableChild = [
  string,
  ReturnType<typeof run>["childSessionIdentity"],
  Partial<(typeof mocks.entries)[string]>,
  boolean,
];

function expectNoSessionEffects() {
  expect(dispatchAgent).not.toHaveBeenCalled();
  expect(mocks.applySessionEntryExactReplacements).not.toHaveBeenCalled();
}

function retireOrphan(
  entry: ReturnType<typeof run>,
  session: Partial<(typeof mocks.entries)[string]> = {},
) {
  entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
  rotateAgentEventLifecycleGeneration();
  Object.assign(mocks.entries[childSessionKey]!, {
    lifecycleRunId: entry.runId,
    abortedLastRun: false,
    ...session,
  });
}

function hiddenRecovery(entry: ReturnType<typeof run>) {
  entry.taskRunId = "original-task-run";
  entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
}

function heldRecovery(entries: ReturnType<typeof run>[]) {
  const preparation = createDeferred<number | undefined>();
  const entered = createDeferred();
  let preparations = 0;
  const harness = createSubagentSweeperHarness(
    {
      current: {
        ...gatewayRuntime,
        prepareRestartRecovery: () => {
          preparations++;
          entered.resolve();
          return preparation.promise;
        },
      },
    },
    entries[0],
  );
  for (const entry of entries) {
    harness.runs.set(entry.runId, entry);
    if (entry.childSessionKey !== childSessionKey) {
      mocks.entries[entry.childSessionKey] = { ...mocks.entries[childSessionKey]! };
    }
  }
  return { ...harness, preparation, entered, preparations: () => preparations };
}

describe("subagent registry restart recovery", () => {
  beforeEach(() => restartRecoveryTestHarness.reset());

  it.each<UnverifiableChild>([
    ["missing identity", undefined, {}, false],
    ["missing revision", { sessionId: "session-id" }, { lifecycleRevision: "replacement" }, false],
    [
      "newer execution",
      { sessionId: "session-id", lifecycleRevision: "session-revision" },
      { lifecycleRunId: "newer-visible-run" },
      false,
    ],
    [
      "legacy successor",
      undefined,
      { status: "done", lifecycleRunId: "successor-run", abortedLastRun: false },
      false,
    ],
    ...[undefined, "replacement-revision"].map((lifecycleRevision): UnverifiableChild => [
      "changed revision",
      { sessionId: "session-id", lifecycleRevision: "original-revision" },
      { lifecycleRevision },
      true,
    ]),
  ])(
    "settles %s without changing the unverifiable child",
    async (_case, identity, session, retired) => {
      const entry = run({ childSessionIdentity: identity });
      if (retired) {
        retireOrphan(entry);
      }
      Object.assign(mocks.entries[childSessionKey]!, session);
      const before = structuredClone({ entry, session: mocks.entries[childSessionKey] });
      const result = await recover(entry);
      expect(result).toMatchObject({ status: "terminal", suppressSessionEffects: true });
      if (retired && result.status === "terminal") {
        expect(result.error).toContain("original session incarnation changed");
        expect(await result.recoveryCurrent?.prepare()).toBe(true);
        expect(result.sessionEffects).toBeUndefined();
        expect(restartRecoveryTestHarness.warn).not.toHaveBeenCalled();
      }
      expect({ entry, session: mocks.entries[childSessionKey] }).toEqual(before);
      expectNoSessionEffects();
    },
  );

  it.each([false, true])(
    "does not replay cleaned interruption effects with requester wake=%s",
    async (pendingWake) => {
      const entry = run({
        terminalOwner: "interrupted-recovery",
        endedAt: 200,
        endedReason: "subagent-error",
        outcome: { status: "error", error: "interrupted" },
        cleanupCompletedAt: 300,
        cleanupHandled: true,
        delivery: { status: "delivered", deliveredAt: 250 },
        ...(pendingWake
          ? { requesterSettleWake: { status: "pending" as const, attemptCount: 0 } }
          : {}),
      });
      const before = structuredClone(entry);
      const { sweeper, runs, finalizeInterruptedSubagentRun } = createSubagentSweeperHarness(
        { current: gatewayRuntime },
        entry,
      );

      await sweeper.recoverInterruptedRuns();
      await sweeper.sweepOnce();

      expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
      expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
      expect(dispatchAgent).not.toHaveBeenCalled();
      expect(runs.get(entry.runId)).toEqual(before);
    },
  );

  it("pauses startup settlement until the crash-loop breaker releases the periodic sweep", async () => {
    vi.useFakeTimers();
    const pausedUntilMs = Date.now() + 2_000;
    const runtime = {
      ...gatewayRuntime,
      prepareRestartRecovery: () =>
        Date.now() < pausedUntilMs ? Promise.resolve(pausedUntilMs) : undefined,
    };
    const { sweeper, finalizeInterruptedSubagentRun } = createSubagentSweeperHarness(
      { current: runtime },
      run(),
    );
    finalizeInterruptedSubagentRun.mockResolvedValue(1);
    try {
      await sweeper.recoverInterruptedRuns();
      await sweeper.sweepOnce();
      expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
      expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
      expect(dispatchAgent).not.toHaveBeenCalled();
    } finally {
      await sweeper.reset();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "bounds sibling recovery across startup groups (retired=%s)",
    async (retired) => {
      const entries = Array.from({ length: 9 }, (_, index) =>
        run({
          runId: `interrupted-${index}`,
          childSessionKey: `agent:main:subagent:interrupted-${index}`,
        }),
      );
      const { sweeper, finalizeInterruptedSubagentRun, preparation, entered, preparations } =
        heldRecovery(entries);
      const startup = Promise.all([
        sweeper.recoverInterruptedRuns(entries.slice(0, 5)),
        sweeper.recoverInterruptedRuns(entries.slice(5)),
      ]);
      try {
        await entered.promise;
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(preparations()).toBe(8);
        // Repeated activation cannot queue a second attempt behind the current one.
        await sweeper.recoverInterruptedRuns(entries);
        expect(preparations()).toBe(8);
        expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
        if (retired) {
          rotateAgentEventLifecycleGeneration();
        }
      } finally {
        preparation.resolve(undefined);
        await startup;
        await sweeper.reset();
      }
      expect(
        finalizeInterruptedSubagentRun.mock.calls.map(([params]) => params.runId).toSorted(),
      ).toEqual(retired ? [] : entries.map((entry) => entry.runId).toSorted());
      expect(preparations()).toBe(retired ? 8 : 9);
    },
  );

  it.each(["run", "admission", "run after admission"] as const)(
    "recovers as soon as a retained %s releases ownership",
    async (owner) => {
      vi.useFakeTimers();
      const entry = run();
      entry.execution.status = "interrupted";
      const { sweeper, finalizeInterruptedSubagentRun } = createSubagentSweeperHarness(
        { current: gatewayRuntime },
        entry,
      );
      const lease =
        owner !== "run"
          ? await beginSessionEffect({
              scope: mocks.storePath,
              identities: [childSessionKey, "session-id"],
              assertAllowed: () => {},
            })
          : undefined;
      if (owner !== "admission") {
        registerAgentRunContext("retained-owner", {
          sessionKey: childSessionKey,
          sessionId: "session-id",
        });
      }
      try {
        await sweeper.sweepOnce();
        mocks.loadSessionEntry.mockClear();
        await sweeper.sweepOnce();
        expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
        expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
        lease?.release();
        if (owner === "run after admission") {
          await vi.advanceTimersByTimeAsync(1_000);
          expect(finalizeInterruptedSubagentRun).not.toHaveBeenCalled();
        }
        clearAgentRunContext("retained-owner");
        await vi.advanceTimersByTimeAsync(1_000);
        expect(mocks.loadSessionEntry).toHaveBeenCalled();
        expect(finalizeInterruptedSubagentRun).toHaveBeenCalledOnce();
      } finally {
        await sweeper.reset();
        lease?.release();
        clearAgentRunContext("retained-owner");
        vi.useRealTimers();
      }
    },
  );

  it.each(
    (["yield", "steer", "kill", "queued"] as const).flatMap((owner) =>
      (["initial", "currency"] as const).map((read) => ({ owner, read })),
    ),
  )(
    "abandons recovery when $owner takes ownership during the $read session read",
    async ({ owner, read }) => {
      const entry = run();
      const readEntry = read === "initial" ? mocks.loadSessionEntry : mocks.readSessionCurrent;
      readEntry.mockImplementationOnce(() => {
        if (owner === "yield") {
          entry.pauseReason = "sessions_yield";
        }
        if (owner === "steer") {
          entry.suppressAnnounceReason = "steer-restart";
        }
        if (owner === "kill") {
          entry.killIntent = { requestedAt: Date.now(), reason: "killed" };
        }
        if (owner === "queued") {
          entry.execution.status = "queued";
        }
        return mocks.entries[childSessionKey];
      });
      expect(await recover(entry)).toEqual({ status: "deferred" });
      expectNoSessionEffects();
    },
  );

  describe("orphaned session executions", () => {
    it.each([60_000, 3 * 24 * 60 * 60_000])(
      "reconciles a hard-kill orphan last observed %i ms ago",
      async (ageMs) => {
        const entry = run();
        const updatedAt = Date.now() - ageMs;
        retireOrphan(entry, { status: undefined, updatedAt });

        expect(await recover(entry)).toMatchObject({
          status: "terminal",
          error: expect.stringContaining("Gateway restart"),
        });
        expect(mocks.entries[childSessionKey]?.updatedAt).toBe(updatedAt);
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(gatewayRuntime.sendRecoveryNotice).not.toHaveBeenCalled();
      },
    );

    it.each([
      "current lifecycle",
      "completed session",
      "completed session with stale abort marker",
      "legacy completed session",
      "legacy completed session with stale abort marker",
    ])("does not invent a restart interruption for a %s", async (scenario) => {
      const entry = run(scenario.startsWith("legacy") ? { childSessionIdentity: undefined } : {});
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
      if (scenario !== "current lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      Object.assign(mocks.entries[childSessionKey]!, {
        status: scenario.includes("completed session") ? "done" : undefined,
        lifecycleRunId: entry.runId,
        lastRunId: undefined,
        abortedLastRun: scenario.endsWith("stale abort marker"),
      });
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expectNoSessionEffects();
    });

    it.each([
      "current lifecycle",
      "different task",
      "different recovery",
      "newer visible run",
      "missing transcript",
    ])("does not adopt a hidden recovery with %s", async (scenario) => {
      const entry = run({ taskRunId: "original-task-run" });
      entry.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
      entry.execution.transcriptTarget = { sessionKey: "agent:main:internal:recovered" };
      if (scenario !== "current lifecycle") {
        rotateAgentEventLifecycleGeneration();
      }
      Object.assign(mocks.entries[childSessionKey]!, {
        status: undefined,
        lifecycleRunId: scenario === "newer visible run" ? "visible-run" : "original-task-run",
        abortedLastRun: false,
        subagentRecovery: {
          lastRunId: scenario === "different recovery" ? "older-recovery" : entry.runId,
          ...(scenario !== "different task" ? { sessionLifecycleRunId: "original-task-run" } : {}),
        },
      });
      if (scenario === "different task") {
        entry.taskRunId = "different-task-run";
      }
      if (scenario === "missing transcript") {
        entry.execution.transcriptTarget = undefined;
      }
      expect(await recover(entry)).toEqual({ status: "ignored" });
      expectNoSessionEffects();
    });

    it.each(["session", "visible turn"])(
      "keeps a replacement %s untouched when orphan marking waits for the store",
      async (replacementKind) => {
        const entry = run();
        if (replacementKind === "visible turn") {
          hiddenRecovery(entry);
        }
        retireOrphan(entry, {
          status: undefined,
          lifecycleRunId: replacementKind === "visible turn" ? "steered-source" : entry.runId,
          subagentRecovery: {
            lastRunId: entry.runId,
            sessionLifecycleRunId:
              replacementKind === "visible turn" ? "steered-source" : entry.runId,
          },
        });
        const replacementSessionId =
          replacementKind === "session" ? "replacement-session" : "session-id";
        mocks.applySessionEntryExactReplacements.mockImplementationOnce(async ({ update }) => {
          const replacement = {
            ...mocks.entries[childSessionKey]!,
            sessionId: replacementSessionId,
            lifecycleRunId: "replacement-run",
          };
          mocks.entries[childSessionKey] = replacement;
          return (await update([{ sessionKey: childSessionKey, entry: replacement }])).result;
        });
        expect(await recover(entry)).toEqual({ status: "deferred" });
        expect(dispatchAgent).not.toHaveBeenCalled();
        expect(mocks.entries[childSessionKey]).toMatchObject({
          sessionId: replacementSessionId,
          lifecycleRunId: "replacement-run",
          abortedLastRun: false,
        });
      },
    );
  });

  it.each(["terminal", "non-aborted"])("leaves %s ownership unchanged", async (owner) => {
    const entry = run();
    if (owner === "terminal") {
      entry.execution = { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } };
    }
    if (owner === "non-aborted") {
      mocks.entries[childSessionKey]!.abortedLastRun = false;
    }
    expect(await recover(entry)).toEqual({ status: "ignored" });
    expect(dispatchAgent).not.toHaveBeenCalled();
  });
});

describe("interrupted requester-settle continuation ownership", () => {
  beforeEach(() => restartRecoveryTestHarness.reset());
  afterEach(() => subagentRuns.clear());

  function cohort(quiet = false) {
    const child = run({
      runId: "settled-leaf",
      childSessionKey: "agent:main:subagent:leaf",
      requesterSessionKey: childSessionKey,
      requesterAgentId: "main",
      requesterStorePath: "/tmp/openclaw-subagent-recovery/agents/main/agent/openclaw-agent.sqlite",
      completionRequesterSessionId: "session-id",
      completionRequesterLifecycleRevision: "session-revision",
      expectsCompletionMessage: !quiet,
      completionTarget: quiet ? "parent" : undefined,
      execution: {
        status: "terminal",
        endedAt: Date.now(),
        outcome: { status: quiet ? "error" : "ok" },
        interruptionReason: quiet ? "gateway-restart" : undefined,
      },
      requesterSettleWake: {
        status: "dispatching",
        attemptCount: 1,
        batchRunIds: ["settled-leaf"],
        requesterYieldBatch: quiet ? undefined : true,
        rearmGeneration: quiet ? undefined : 1,
      },
    });
    const { runId } = buildRequesterSettleWakeIdentity({
      requesterSessionKey: childSessionKey,
      requesterAgentId: "main",
      batchRunIds: [child.runId],
      rearmGeneration: quiet ? undefined : 1,
    });
    const worker = run({ runId, taskRunId: "original-task" });
    worker.execution.status = "interrupted";
    worker.execution.interruptionReason = "gateway-restart";
    mocks.entries[childSessionKey]!.lifecycleRunId = runId;
    const context = { recoveryRuntime: gatewayRuntime } as GatewayRequestContext;
    let open = true;
    bindGatewayContextResolver(child, () => (open ? context : undefined));
    subagentRuns.set(worker.runId, worker);
    subagentRuns.set(child.runId, child);
    return {
      child,
      worker,
      close: () => {
        open = false;
      },
    };
  }

  it("does not mark a hard-killed incoming continuation as an orphan", async () => {
    const { worker } = cohort();
    worker.execution.status = "running";
    worker.execution.lifecycleGeneration = getAgentEventLifecycleGeneration();
    Object.assign(mocks.entries[childSessionKey]!, {
      status: undefined,
      abortedLastRun: false,
    });
    rotateAgentEventLifecycleGeneration();

    expect(await recover(worker)).toEqual({ status: "handled" });
    expect(mocks.entries[childSessionKey]?.abortedLastRun).toBe(false);
    expect(mocks.applySessionEntryExactReplacements).not.toHaveBeenCalled();
    expect(restartRecoveryTestHarness.warn).not.toHaveBeenCalled();
  });

  it.each([
    [false, false, false, false],
    [false, true, false, false],
    [true, false, false, false],
    [true, true, true, false],
    [true, false, true, false],
    [false, false, false, true],
  ])(
    "keeps the saved wake owned (private %s, physical locator %s, quiet %s, legacy %s)",
    async (privateCompletion, physicalLocator, quiet, legacy) => {
      const { child, worker } = cohort(quiet);
      if (legacy) {
        worker.childSessionIdentity = undefined;
      }
      if (physicalLocator) {
        mocks.storePath = child.requesterStorePath!;
      }
      if (privateCompletion) {
        child.completionTarget = "parent";
      }
      expect(await recover(worker)).toEqual({ status: "handled" });
      expect(worker.execution.outcome).toBeUndefined();
      expectNoSessionEffects();
    },
  );

  it.each([
    "non-cohort batch",
    "rearmed",
    "superseded initial attempt",
    "unstarted",
    "consumed",
    "different session",
    "different agent",
    "different store",
    "replaced child",
    "closed gateway",
    "cancelled custody",
    "suppressed delivery",
    "legacy launch receipt",
    "quiet reset parent",
    "quiet cancelled custody",
    "quiet unstarted",
  ])("retains ordinary interruption recovery for %s", async (scenario) => {
    const { child, worker, close } = cohort(scenario.startsWith("quiet "));
    if (scenario === "non-cohort batch") {
      child.requesterSettleWake!.requesterYieldBatch = undefined;
      child.requesterSettleWake!.rearmGeneration = undefined;
    }
    if (scenario === "rearmed") {
      child.requesterSettleWake!.rearmGeneration!++;
    }
    if (scenario === "superseded initial attempt") {
      child.requesterSettleWake!.attemptCount = 3;
    }
    if (scenario === "unstarted" || scenario === "quiet unstarted") {
      child.requesterSettleWake!.attemptCount = 0;
    }
    if (scenario === "consumed") {
      child.requesterSettleWake = undefined;
    }
    if (scenario === "different session") {
      child.completionRequesterSessionId = "replacement";
    }
    if (scenario === "different agent") {
      child.requesterAgentId = "other";
    }
    if (scenario === "different store") {
      child.requesterStorePath = "/tmp/replacement.sqlite";
    }
    if (scenario === "replaced child") {
      subagentRuns.set("replacement-leaf", {
        ...child,
        runId: "replacement-leaf",
        taskRunId: child.taskRunId ?? child.runId,
        generation: (child.generation ?? 1) + 1,
      });
    }
    if (scenario === "closed gateway") {
      close();
    }
    if (scenario === "cancelled custody" || scenario === "quiet cancelled custody") {
      child.killReconciliation = { killedAt: Date.now(), suppressTaskDelivery: true };
    }
    if (scenario === "suppressed delivery") {
      child.suppressCompletionDelivery = true;
    }
    if (scenario === "legacy launch receipt") {
      worker.execution.restartRecovery = {
        phase: "accepted",
        sessionId: "session-id",
        sessionMarker: "session-id:1",
        idempotencyKey: "old-launch",
      };
    }
    if (scenario === "quiet reset parent") {
      child.completionRequesterLifecycleRevision = "prior-parent-revision";
    }
    expect(await recover(worker)).toMatchObject({
      status: "terminal",
      error: expect.stringContaining("Gateway restart"),
    });
  });

  it.each(["deliverable", "yielded private", "paused private"] as const)(
    "preserves a pre-cutover retry continuation for %s custody",
    async (policy) => {
      const { child, worker } = cohort();
      child.requesterSettleWake!.attemptCount = 2;
      if (policy !== "deliverable") {
        child.completionTarget = "parent";
      }
      if (policy === "yielded private") {
        child.requesterSettleWake!.yieldedFinalDeliverable = true;
      }
      if (policy === "paused private") {
        child.pauseReason = "sessions_yield";
        child.requesterSettleWake!.pauseNotice = { acknowledgment: "Waiting for direction" };
      }
      const runId =
        policy === "paused private"
          ? "announce:requester-settle:main:agent:main:subagent:restart-child:settled-leaf:yield-1:pause:retry-1"
          : "announce:requester-settle:main:agent:main:subagent:restart-child:settled-leaf:yield-1:retry-1";
      subagentRuns.delete(worker.runId);
      const restored = run({ ...worker, runId });
      mocks.entries[childSessionKey]!.lifecycleRunId = runId;
      subagentRuns.set(runId, restored);

      expect(await recover(restored)).toEqual({ status: "handled" });
      expect(restored.execution.outcome).toBeUndefined();
      expectNoSessionEffects();
    },
  );

  it("keeps the dispatched surviving cohort owned after a member retires", async () => {
    const { child, worker } = cohort();
    child.requesterSettleWake!.batchRunIds!.push("retired-member");

    expect(await recover(worker)).toEqual({ status: "handled" });
    expectNoSessionEffects();
  });

  it.each(["yielded", "finished", "same-task replacement"] as const)(
    "preserves independent shared-session task custody after a %s requester restarts",
    async (scenario) => {
      const { child, worker } = cohort();
      child.generation = 1;
      const sibling = run({
        ...child,
        runId: "second-leaf-task",
        generation: 2,
        taskRunId: scenario === "same-task replacement" ? child.runId : "second-leaf-task",
      });
      const children = scenario === "same-task replacement" ? [child] : [child, sibling];
      const batchRunIds = children.map((entry) => entry.runId).toSorted();
      for (const entry of children) {
        entry.requesterSettleWake = {
          ...entry.requesterSettleWake!,
          batchRunIds,
          requesterYieldBatch: scenario === "finished" ? undefined : true,
        };
      }
      const continuationRunId = buildRequesterSettleWakeIdentity({
        requesterSessionKey: childSessionKey,
        requesterAgentId: "main",
        batchRunIds,
        rearmGeneration: 1,
      }).runId;
      subagentRuns.delete(worker.runId);
      const continuation = run({ ...worker, runId: continuationRunId });
      mocks.entries[childSessionKey]!.lifecycleRunId = continuation.runId;
      bindGatewayContextResolver(sibling, getGatewayContextResolver(child)!);
      subagentRuns.set(sibling.runId, sibling);
      subagentRuns.set(continuation.runId, continuation);

      const result = await recover(continuation);
      expect(result.status).toBe(scenario === "same-task replacement" ? "terminal" : "handled");
      expect(continuation.execution.outcome).toBeUndefined();
      expect(dispatchAgent).not.toHaveBeenCalled();
    },
  );

  it("rechecks incoming custody before a classified interruption can commit", async () => {
    const { child, worker } = cohort();
    subagentRuns.delete(child.runId);
    const result = await recover(worker);
    expect(result.status).toBe("terminal");
    if (result.status !== "terminal") {
      throw new Error("missing interruption classification");
    }
    expect(await result.recoveryCurrent?.prepare()).toBe(true);
    expect(result.recoveryCurrent?.isHostCurrent()).toBe(true);
    subagentRuns.set(child.runId, child);
    expect(result.recoveryCurrent?.isHostCurrent()).toBe(false);
    expect(await result.recoveryCurrent?.prepare()).toBe(false);
  });
});
