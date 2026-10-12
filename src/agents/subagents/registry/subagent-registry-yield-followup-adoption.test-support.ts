import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
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
    "callGateway" | "runSubagentAnnounceFlow" | "dispatchRecoveryAgent"
  >;
  findRequesterRun: (runId: string, requesterSessionKey?: string) => SubagentRunRecord | undefined;
  getLifecycleHandler: () => (event: LifecycleEvent) => void;
  updateFixtureRun: (runId: string, update: (entry: SubagentRunRecord) => void) => Promise<void>;
  settleLifecycle: (event: LifecycleEvent) => Promise<void>;
  wakeRequester: Mock<typeof maybeWakeRequesterAfterAllChildrenSettled>;
}) {
  it.each(
    ["complete", "yield during restart", "restart after pause"].flatMap((ending) =>
      ["lifecycle", "wait"].map((first) => ({ ending, first })),
    ),
  )("settles $ending once with $first arriving first", async ({ ending, first }) => {
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
      expect(
        await getRegistry().claimSubagentYield({
          runId,
          sessionKey: childSessionKey,
          agentId: "main",
          waitForMessage: true,
          hasPendingWork: () => false,
        }),
      ).toEqual({ messageWaitRegistered: true });
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
      expect(run?.execution.outcome).toBeUndefined();
      expect(run?.endedReason).toBeUndefined();
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
      mockGatewayMethods(mocks.callGateway, { "agent.wait": { status: "pending" } });
      const runId = "run-late-yield";
      const childSessionKey = "agent:main:subagent:late-yield";
      await getRegistry().registerSubagentRun({
        runId,
        childSessionKey,
        task: "handle authoritative late yield",
      });
      const lifecycleHandler = getLifecycleHandler();
      let killedCleanupAt: number | undefined;
      if (killed) {
        lifecycleHandler({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 111, endedAt: 222, yielded: true },
        });
        expect(
          await getRegistry().markSubagentRunTerminated({
            runId,
            childSessionKey,
            reason: "killed",
          }),
        ).toBe(1);
        const run = findRequesterRun(runId);
        expect(run).toMatchObject({
          execution: { status: "terminal", endedAt: 222 },
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          cleanupHandled: true,
          suppressAnnounceReason: "killed",
        });
        expect(run?.pauseReason).toBeUndefined();
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
      const event = {
        runId,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 111, endedAt: 333, yielded: true },
      };
      if (killed) {
        lifecycleHandler(event);
      } else {
        await settleLifecycle(event);
      }
      const run = findRequesterRun(runId);
      if (killed) {
        expect(run).toMatchObject({
          execution: { status: "terminal", endedAt: 222 },
          endedReason: SUBAGENT_ENDED_REASON_KILLED,
          cleanupHandled: true,
          cleanupCompletedAt: killedCleanupAt,
          suppressAnnounceReason: "killed",
        });
        expect(run?.pauseReason).toBeUndefined();
      } else {
        expect(run).toMatchObject({
          execution: { status: "terminal", endedAt: 333 },
          pauseReason: "sessions_yield",
          cleanupHandled: false,
          delivery: { status: "pending" },
        });
        expect(run?.endedReason).toBeUndefined();
        expect(run?.execution.outcome).toBeUndefined();
        expect(run?.cleanupCompletedAt).toBeUndefined();
      }
    },
  );

  describe("sessions_yield follow-up adoption", () => {
    const CHILD_SESSION_KEY = "agent:main:subagent:yield-followup";
    const PAUSED_RUN_ID = "run-yield-followup-paused";
    const FOLLOW_UP_RUN_ID = "run-yield-followup-continued";
    const SIBLING_RUN_ID = "run-yield-followup-sibling";
    const ORIGINAL_REQUESTER = "agent:main:telegram:direct:777";

    const arrangeYieldingChild = async () => {
      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": createDeferred<Record<string, unknown>>().promise,
      });
      await getRegistry().registerSubagentRun({
        runId: PAUSED_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        requesterSessionKey: ORIGINAL_REQUESTER,
        expectsCompletionMessage: true,
        task: "wait for the remote job",
      });
      expect(
        await getRegistry().claimSubagentYield({
          runId: PAUSED_RUN_ID,
          sessionKey: CHILD_SESSION_KEY,
          agentId: "main",
          waitForMessage: true,
          hasPendingWork: () => false,
          acknowledgment: "Paused awaiting continuation.",
        }),
      ).toEqual({ messageWaitRegistered: true });
      return expectDefined(findRequesterRun(PAUSED_RUN_ID, ORIGINAL_REQUESTER), "yielding run");
    };

    const registerFollowUp = (requesterSessionKey?: string) =>
      getRegistry().registerSubagentRun({
        runId: FOLLOW_UP_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        requesterSessionKey: requesterSessionKey ?? "agent:main:main",
        controllerSessionKey: "agent:main:main",
        requesterDisplayKey: requesterSessionKey ?? "main",
        expectsCompletionMessage: requesterSessionKey !== undefined,
        task: "the remote job finished",
        cleanup: "keep",
        spawnMode: "run",
        label: "plugin:qa",
      });

    /**
     * Drives a child run to the paused state a `sessions_yield` produces, then
     * arms the wake credential that `settleRequesterTurnAfterSessionSpawns`
     * writes when the parent yields behind its own spawn batch.
     */
    const arrangePausedChildWithYieldedRequester = async (
      requesterSessionKey = "agent:main:main",
    ) => {
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
      await getRegistry().registerSubagentRun({
        runId: PAUSED_RUN_ID,
        childSessionKey: CHILD_SESSION_KEY,
        requesterSessionKey,
        task: "wait for the remote job",
      });
      await waitForFast(() => {
        const run = expectDefined(
          findRequesterRun(PAUSED_RUN_ID, requesterSessionKey),
          "paused subagent run",
        );
        expect(run.pauseReason).toBe("sessions_yield");
        return run;
      });
      await updateFixtureRun(PAUSED_RUN_ID, (next) => {
        next.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          afterRequesterYield: true,
          rearmGeneration: 1,
          batchRunIds: [SIBLING_RUN_ID, PAUSED_RUN_ID].toSorted(),
        };
      });
      expect(mocks.runSubagentAnnounceFlow).not.toHaveBeenCalled();
      return expectDefined(
        findRequesterRun(PAUSED_RUN_ID, requesterSessionKey),
        "published paused run",
      );
    };

    it("announces to the original requester once the adopted follow-up ends normally", async () => {
      await arrangePausedChildWithYieldedRequester();

      mockGatewayMethods(mocks.callGateway, {
        "agent.wait": {
          status: "ok",
          startedAt: 333,
          endedAt: 444,
          stopReason: "end_turn",
        },
      });
      expect(
        await getRegistry().adoptPausedSubagentRunForFollowUp({
          childSessionKey: CHILD_SESSION_KEY,
          runId: FOLLOW_UP_RUN_ID,
          task: "the remote job finished",
        }),
      ).toBe(true);

      expect(findRequesterRun(PAUSED_RUN_ID)).toBeUndefined();
      const adopted = expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "adopted follow-up run");
      // Adoption continues the same unit of work: the requester identity that
      // spawned the paused run must survive, or the announce lands on the
      // child's own session instead of the waiting parent.
      expect(adopted.requesterSessionKey).toBe("agent:main:main");
      expect(adopted.task).toBe("the remote job finished");
      expect(adopted.pauseReason).toBeUndefined();
      // The frozen batch is addressed by runId, so the retired id must be
      // remapped or this row drops out of the batch it still gates.
      expect(adopted.requesterSettleWake?.batchRunIds).toEqual(
        [SIBLING_RUN_ID, FOLLOW_UP_RUN_ID].toSorted(),
      );
      expect(adopted.requesterSettleWake).toMatchObject({
        requesterYieldBatch: true,
        rearmGeneration: 1,
      });

      await waitForFast(() => {
        expect(
          expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "adopted follow-up run").execution
            .endedAt,
        ).toBe(444);
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalled();
      });
    });

    it("hands the pause to a default follow-up admitted while the child was still yielding", async () => {
      const kickoff = await arrangeYieldingChild();
      const followUpWait = createDeferred<{ status: "ok"; startedAt: number; endedAt: number }>();
      mockGatewayMethods(mocks.callGateway, { "agent.wait": followUpWait.promise });
      await registerFollowUp();
      const successor = expectDefined(findRequesterRun(FOLLOW_UP_RUN_ID), "admitted follow-up");

      getLifecycleHandler()({
        runId: PAUSED_RUN_ID,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 111, endedAt: 222, yielded: true },
      });
      const adopted = await waitForFast(() => {
        expect(findRequesterRun(PAUSED_RUN_ID, ORIGINAL_REQUESTER)).toBeUndefined();
        return expectDefined(
          findRequesterRun(FOLLOW_UP_RUN_ID, ORIGINAL_REQUESTER),
          "adopted follow-up",
        );
      });
      expect(adopted).toMatchObject({
        requesterSessionKey: ORIGINAL_REQUESTER,
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
        expect(findRequesterRun(FOLLOW_UP_RUN_ID, ORIGINAL_REQUESTER)?.execution.endedAt).toBe(444);
        expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledWith(
          expect.objectContaining({
            childRunId: FOLLOW_UP_RUN_ID,
            requesterSessionKey: ORIGINAL_REQUESTER,
          }),
        );
      });
      expect(mocks.runSubagentAnnounceFlow).toHaveBeenCalledOnce();
    });

    it("keeps a requester-bound follow-up separate when the child publishes its pause", async () => {
      await arrangeYieldingChild();
      const followUpRequester = "agent:main:telegram:direct:555";
      await registerFollowUp(followUpRequester);

      await settleLifecycle({
        runId: PAUSED_RUN_ID,
        stream: "lifecycle",
        data: { phase: "end", startedAt: 111, endedAt: 222, yielded: true },
      });

      expect(findRequesterRun(PAUSED_RUN_ID, ORIGINAL_REQUESTER)).toMatchObject({
        pauseReason: "sessions_yield",
        requesterSessionKey: ORIGINAL_REQUESTER,
        expectsCompletionMessage: true,
      });
      expect(findRequesterRun(FOLLOW_UP_RUN_ID, followUpRequester)).toMatchObject({
        requesterSessionKey: followUpRequester,
        expectsCompletionMessage: true,
        execution: { status: "running" },
      });
    });
  });
}
