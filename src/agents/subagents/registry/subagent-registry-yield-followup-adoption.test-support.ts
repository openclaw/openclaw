import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import {
  mockGatewayMethods,
  waitForFast,
  type SubagentRegistryHarness,
} from "../../subagent-test-fixtures.test-helpers.js";
import type { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import type { createSubagentRegistryMockState } from "./subagent-registry.mock-state.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type LifecycleEvent = Pick<AgentEventPayload, "runId" | "stream" | "data">;

export function registerYieldFollowupAdoptionTests({
  getRegistry,
  mocks,
  findRequesterRun,
  getLifecycleHandler,
  updateFixtureRun,
  settleLifecycle,
  mockPendingAgentWait,
  wakeRequester,
}: {
  getRegistry: () => SubagentRegistryHarness;
  mocks: Pick<
    ReturnType<typeof createSubagentRegistryMockState>,
    "callGateway" | "runSubagentAnnounceFlow" | "dispatchRecoveryAgent"
  >;
  findRequesterRun: (runId: string, requesterSessionKey?: string) => SubagentRunRecord | undefined;
  getLifecycleHandler: () => (event: LifecycleEvent) => void;
  updateFixtureRun: (runId: string, update: (entry: SubagentRunRecord) => void) => Promise<void>;
  settleLifecycle: (event: LifecycleEvent) => Promise<void>;
  mockPendingAgentWait: () => void;
  wakeRequester: Mock<typeof maybeWakeRequesterAfterAllChildrenSettled>;
}) {
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
        requesterSettleWake: { batchRunIds: [FOLLOW_UP_RUN_ID] },
      });
      expect(adopted.execution).toEqual(successor.execution);
      expect(adopted.generation).toBeGreaterThan(
        expectDefined(successor.generation, "admitted follow-up generation"),
      );
      expect(adopted.requesterSettleWake?.pauseNotice).toBeUndefined();
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

    it("adopts a default sibling registered after the pause was published", async () => {
      const paused = await arrangePausedChildWithYieldedRequester(ORIGINAL_REQUESTER);
      mockPendingAgentWait();
      await registerFollowUp();

      expect(
        await getRegistry().adoptPausedSubagentRunIntoSuccessor({
          childSessionKey: CHILD_SESSION_KEY,
        }),
      ).toBe(true);

      expect(findRequesterRun(PAUSED_RUN_ID, ORIGINAL_REQUESTER)).toBeUndefined();
      expect(findRequesterRun(FOLLOW_UP_RUN_ID, ORIGINAL_REQUESTER)).toMatchObject({
        requesterSessionKey: ORIGINAL_REQUESTER,
        taskRunId: paused.taskRunId ?? paused.runId,
        requesterSettleWake: { batchRunIds: [SIBLING_RUN_ID, FOLLOW_UP_RUN_ID].toSorted() },
      });
    });
  });
}
