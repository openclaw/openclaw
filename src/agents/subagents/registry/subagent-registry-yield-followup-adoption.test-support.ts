import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  createSessionEntry,
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleEvent = Pick<AgentEventPayload, "runId" | "stream" | "data">;

export function registerYieldFollowupAdoptionTests({
  getRegistry,
  bindWakeMutation,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  updateFixtureRun,
  settleLifecycle,
  wakeRequester,
}: {
  getRegistry: () => SubagentRegistryHarness;
  bindWakeMutation: (entries: readonly SubagentRunRecord[]) => void;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    | "callGateway"
    | "runSubagentAnnounceFlow"
    | "dispatchRecoveryAgent"
    | "entries"
    | "persistRegistryRows"
  >;
  findRequesterRun: (runId: string, requesterSessionKey?: string) => SubagentRunRecord | undefined;
  getLifecycleHandler: () => (event: LifecycleEvent) => void;
  updateFixtureRun: (runId: string, update: (entry: SubagentRunRecord) => void) => Promise<void>;
  settleLifecycle: (event: LifecycleEvent) => Promise<void>;
  wakeRequester: Mock<typeof maybeWakeRequesterAfterAllChildrenSettled>;
}) {
  const endedEvent = (runId: string, endedAt = 222): LifecycleEvent => ({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt: 111, endedAt, yielded: true },
  });
  const claimYield = async (runId: string, sessionKey: string, acknowledgment?: string) => {
    expect(
      await getRegistry().claimSubagentYield({
        runId,
        sessionKey,
        acknowledgment,
        agentId: "main",
        waitForMessage: true,
        hasPendingWork: () => false,
      }),
    ).toEqual({ messageWaitRegistered: true });
  };
  const seedSession = (key: string, suffix: string) =>
    (mocks.entries[key] = createSessionEntry({
      sessionId: `sess-${suffix}`,
      lifecycleRevision: `revision-${suffix}`,
    }));
  const requireRun = (id: string, requester?: string) =>
    expectDefined(findRequesterRun(id, requester), "subagent run");
  const expectUnpausedKill = (run: SubagentRunRecord | undefined, extra = {}) => {
    expect(run).toMatchObject({
      execution: { status: "terminal", endedAt: 222 },
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      cleanupHandled: true,
      suppressAnnounceReason: "killed",
      ...extra,
    });
    expect(run?.pauseReason).toBeUndefined();
  };

  it.each(
    ["complete", "yield during restart", "restart after pause"].flatMap((ending) =>
      ["lifecycle", "wait"].map((first) => ({ ending, first })),
    ),
  )("settles $ending once with $first arriving first", async ({ ending, first }) => {
    mocks.persistRegistryRows.mockImplementation(saveSubagentRegistryChangesToSqlite);
    const runId = "run-observation-order";
    const childSessionKey = "agent:main:subagent:child";
    const waitResult = createDeferred<Record<string, unknown>>();
    mockGatewayMethods(mocks.callGateway, { "agent.wait": waitResult.promise });
    await getRegistry().registerSubagentRun({
      runId,
      childSessionKey,
      task: "retain one terminal owner across observers",
      expectsCompletionMessage: true,
    });
    const paused = ending !== "complete";
    if (paused) {
      await claimYield(runId, childSessionKey);
      wakeRequester.mockImplementation(async (params) => {
        bindWakeMutation([params.settledEntry]);
        await params.completeBatch(
          [params.settledEntry],
          params.settledEntry.requesterSettleWake?.rearmGeneration,
        );
        return true;
      });
    }
    const observe = async (source: string) => {
      const yielded = paused && (source === "lifecycle" || ending === "yield during restart");
      const terminal = {
        startedAt: 111,
        endedAt: 222,
        ...(paused
          ? { status: "error", aborted: true, stopReason: "restart", yielded }
          : {
              status: "ok",
              terminalReply: { disposition: "visible", text: "Synthetic final reply." },
            }),
      };
      const settleRootWork = observeRootWork();
      try {
        if (source === "lifecycle") {
          getLifecycleHandler()({
            runId,
            stream: "lifecycle",
            data: { phase: "end", ...terminal },
          });
        } else {
          waitResult.resolve(terminal);
        }
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        await settleRootWork();
      }
    };
    await observe(first);
    if (paused && (first === "lifecycle" || ending === "yield during restart")) {
      expect(findRequesterRun(runId)?.requesterSettleWake?.pauseNotice).toBeUndefined();
    }
    await observe(first === "lifecycle" ? "wait" : "lifecycle");

    const run = findRequesterRun(runId);
    if (paused) {
      expect(run?.pauseReason).toBe("sessions_yield");
      expect([run?.execution.outcome, run?.endedReason]).toEqual([undefined, undefined]);
      expect(wakeRequester).toHaveBeenCalledOnce();
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    } else {
      expect(run?.execution.outcome?.status).toBe("ok");
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    }
    expect(mocks.dispatchRecoveryAgent).not.toHaveBeenCalled();
    expect(mocks.callGateway.mock.calls.filter(([request]) => request.method === "agent")).toEqual(
      [],
    );
  });

  it.each([true, false])(
    "accepts late yield only without a kill owner (killed=%s)",
    async (killed) => {
      mocks.persistRegistryRows.mockImplementation(saveSubagentRegistryChangesToSqlite);
      mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "pending" } });
      const runId = "run-late-yield";
      const childSessionKey = "agent:main:subagent:late-yield";
      const sessionEntry = seedSession(childSessionKey, "late-yield");
      await getRegistry().registerSubagentRun({
        runId,
        childSessionKey,
        sessionEntry,
        task: "handle authoritative late yield",
      });
      const lifecycleHandler = getLifecycleHandler();
      let killedCleanupAt: number | undefined;
      if (killed) {
        lifecycleHandler(endedEvent(runId));
        expect(
          await getRegistry().markSubagentRunTerminated({
            runId,
            childSessionKey,
            reason: "killed",
          }),
        ).toBe(1);
        const run = findRequesterRun(runId);
        expectUnpausedKill(run);
        killedCleanupAt = run?.cleanupCompletedAt;
      } else {
        const run = findRequesterRun(runId);
        expect(run).toBeDefined();
        await updateFixtureRun(runId, (next) =>
          Object.assign(next, {
            endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
            execution: {
              ...run!.execution,
              status: "terminal",
              endedAt: 222,
              outcome: { status: "ok" as const },
            },
            cleanupHandled: true,
            cleanupCompletedAt: 223,
            delivery: { status: "delivered" as const, deliveredAt: 223 },
          }),
        );
      }
      const event = endedEvent(runId, 333);
      if (killed) {
        lifecycleHandler(event);
      } else {
        await settleLifecycle(event);
      }
      const run = findRequesterRun(runId);
      if (killed) {
        expectUnpausedKill(run, { cleanupCompletedAt: killedCleanupAt });
      } else {
        expect(run).toMatchObject({
          execution: { status: "terminal", endedAt: 333 },
          pauseReason: "sessions_yield",
          cleanupHandled: false,
          delivery: { status: "pending" },
        });
        expect([run?.endedReason, run?.execution.outcome, run?.cleanupCompletedAt]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
      }
    },
  );

  const childKey = "agent:main:subagent:yield-followup";
  const pausedId = "run-yield-followup-paused";
  const followupId = "run-yield-followup-continued";
  const siblingId = "run-yield-followup-sibling";
  const requester = "agent:main:telegram:direct:777";
  const followup = {
    runId: followupId,
    childSessionKey: childKey,
    task: "the remote job finished",
  };

  const registerPausedChild = async (
    requesterSessionKey: string,
    expectsCompletionMessage?: boolean,
  ) => {
    seedSession(childKey, "yield-followup");
    await getRegistry().registerSubagentRun({
      runId: pausedId,
      childSessionKey: childKey,
      sessionEntry: mocks.entries[childKey],
      requesterSessionKey,
      expectsCompletionMessage,
      task: "wait for the remote job",
    });
  };

  const arrangeYieldingChild = async () => {
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": createDeferred<Record<string, unknown>>().promise,
    });
    seedSession(requester, "yield-requester");
    await registerPausedChild(requester, true);
    await claimYield(pausedId, childKey, "Paused awaiting continuation.");
    return requireRun(pausedId, requester);
  };

  const registerFollowUp = (requesterSessionKey?: string) =>
    getRegistry().registerSubagentRun({
      ...followup,
      sessionEntry: mocks.entries[childKey],
      requesterSessionKey: requesterSessionKey ?? "agent:main:main",
      controllerSessionKey: "agent:main:main",
      requesterDisplayKey: requesterSessionKey ?? "main",
      expectsCompletionMessage: requesterSessionKey !== undefined,
      cleanup: "keep",
      spawnMode: "run",
      label: "plugin:qa",
    });

  it("announces to the original requester once the adopted follow-up ends normally", async () => {
    const requesterSessionKey = "agent:main:main";
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: 111,
        endedAt: 222,
        stopReason: "end_turn",
        livenessState: "paused",
        yielded: true,
      },
    });
    await registerPausedChild(requesterSessionKey);
    await waitForFast(() => {
      const run = requireRun(pausedId, requesterSessionKey);
      expect(run.pauseReason).toBe("sessions_yield");
    });
    await updateFixtureRun(pausedId, (next) => {
      next.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
        batchRunIds: [siblingId, pausedId].toSorted(),
      };
    });
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    mockGatewayMethods(mocks.callGateway, {
      "agent.wait": {
        status: "ok",
        startedAt: 333,
        endedAt: 444,
        stopReason: "end_turn",
      },
    });
    expect(await getRegistry().adoptPausedSubagentRunForFollowUp({ ...followup })).toBe(true);

    expect(findRequesterRun(pausedId)).toBeUndefined();
    const adopted = requireRun(followupId);
    // The original audience and frozen batch must survive adoption.
    expect(adopted).toMatchObject({
      requesterSessionKey: "agent:main:main",
      task: "the remote job finished",
    });
    expect(adopted.pauseReason).toBeUndefined();
    expect(adopted.requesterSettleWake?.batchRunIds).toEqual([siblingId, followupId].toSorted());
    expect(adopted.requesterSettleWake).toMatchObject({
      requesterYieldBatch: true,
      rearmGeneration: 1,
    });

    await waitForFast(() => {
      expect(requireRun(followupId).execution.endedAt).toBe(444);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalled();
    });
  });

  it("hands the pause to a default follow-up admitted while the child was still yielding", async () => {
    const kickoff = await arrangeYieldingChild();
    const followUpWait = createDeferred<{ status: "ok"; startedAt: number; endedAt: number }>();
    mockGatewayMethods(mocks.callGateway, { "agent.wait": followUpWait.promise });
    await registerFollowUp();
    const successor = requireRun(followupId);

    getLifecycleHandler()(endedEvent(pausedId));
    const adopted = await waitForFast(() => {
      expect(findRequesterRun(pausedId, requester)).toBeUndefined();
      return requireRun(followupId, requester);
    });
    expect(adopted).toMatchObject({
      requesterSessionKey: requester,
      expectsCompletionMessage: true,
      completion: { required: true },
      taskRunId: kickoff.taskRunId ?? kickoff.runId,
      task: "the remote job finished",
    });
    expect(adopted.execution).toEqual(successor.execution);
    expect(adopted.generation).toBeGreaterThan(
      expectDefined(successor.generation, "admitted follow-up generation"),
    );
    expect(adopted.requesterSettleWake).toBeUndefined();
    expect(wakeRequester).not.toHaveBeenCalled();
    expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(mocks.dispatchRecoveryAgent).not.toHaveBeenCalled();

    followUpWait.resolve({ status: "ok", startedAt: 333, endedAt: 444 });
    await waitForFast(() => {
      expect(findRequesterRun(followupId, requester)?.execution.endedAt).toBe(444);
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
        expect.objectContaining({
          childRunId: followupId,
          requesterSessionKey: requester,
        }),
      );
    });
    expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
  });

  it("keeps a requester-bound follow-up separate when the child publishes its pause", async () => {
    await arrangeYieldingChild();
    const followUpRequester = "agent:main:telegram:direct:555";
    await registerFollowUp(followUpRequester);

    await settleLifecycle(endedEvent(pausedId));

    expect(findRequesterRun(pausedId, requester)).toMatchObject({
      pauseReason: "sessions_yield",
      requesterSessionKey: requester,
      expectsCompletionMessage: true,
    });
    expect(findRequesterRun(followupId, followUpRequester)).toMatchObject({
      requesterSessionKey: followUpRequester,
      expectsCompletionMessage: true,
      execution: { status: "running" },
    });
  });
}
