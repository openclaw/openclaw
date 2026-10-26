import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { RestartRecoveryTerminalDeliveryEvidence } from "../../../config/sessions/restart-recovery-types.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { AgentTurnStartRequest } from "../../../gateway/agent-turn/agent-turn-start-request.types.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import { getCurrentSessionControllerClaim } from "../../../sessions/session-controller.lifecycle.js";
import { getExistingSessionControllerMailbox } from "../../../sessions/session-controller.mailbox.js";
import { markReplyOperationExecutionStarted } from "../../../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { prepareEmbeddedAttemptTimeout } from "../../embedded-agent-runner/run/attempt-timeout-prepare.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { consumeSubagentPauseNotice } from "../registry/subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "../registry/subagent-lifecycle-events.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  registerRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import { reserveRestoredSubagentControllerSources } from "./subagent-announce-controller-source.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import {
  deliver,
  loadRequester,
  registryRead,
  readDescendantFacts,
  startTurn,
  REQUESTER_KEY,
  REQUESTER_TARGET,
  REQUESTER_TURN,
  settledChild,
  wakeParams,
  requesterSnapshot,
  useDirectDelivery,
  withGateway,
  useRequesterSettleDispatchFixture,
  finishProcessedCompletion,
  createRequesterSettleContext as createContext,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

afterEach(() => clearRuntimeConfigSnapshot());

type Wake = Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0];
function dispatchFixture(child = settledChild()) {
  registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
  const completeBatch = vi.fn<Wake["completeBatch"]>(() => {
    child.requesterSettleWake = undefined;
  });
  return { child, completeBatch, params: wakeParams(child, completeBatch) };
}

function recoveryEvidence(
  runId: string,
  transcriptRunId: string,
  failed = false,
): RestartRecoveryTerminalDeliveryEvidence {
  return {
    runId,
    transcriptRunId,
    captured: true as const,
    ...(failed
      ? { meta: { error: true } }
      : {
          payloads: [{ visible: true }],
          deliveryStatus: { status: "sent" as const, resultCount: 1 },
        }),
  };
}
type Turn = Pick<AgentTurnStartRequest, "preflight" | "io" | "controllerInput">;
function acceptTurn({ preflight, io }: Turn, cached?: true) {
  const runId = preflight.request.idempotencyKey;
  io.emitAcceptance([true, { runId, status: "accepted" }, undefined], {
    runId,
    ...(cached ? { cached } : {}),
  });
}
function finishTurn(io: Turn["io"], text: string | undefined) {
  io.emitFinal([true, { status: "ok", result: { payloads: [{ text }] } }, undefined]);
}
function registerRequesterTurn({ preflight, controllerInput }: Turn, timeoutMs: number) {
  return registerChatAbortController({
    target: REQUESTER_TARGET,
    runId: preflight.request.idempotencyKey,
    sessionId: "requester-session",
    sessionKey: preflight.request.sessionKey,
    timeoutMs,
    kind: "agent",
    sourceInput: controllerInput,
  });
}

describe("requester settle dispatch deadline", () => {
  useRequesterSettleDispatchFixture();

  beforeEach(() => setRuntimeConfigSnapshot({}));

  it("does not reserve a foreground-blocking source for a wholly superseded yielded cohort", async () => {
    const context = createContext();
    const { child, completeBatch, params } = dispatchFixture();
    child.killReconciliation = { killedAt: 3_000, supersededAt: 4_000 };
    child.suppressCompletionDelivery = true;
    child.requesterSettleWake = {
      ...child.requesterSettleWake!,
      status: "dispatching",
      attemptCount: 1,
      batchRunIds: [child.runId],
    };
    useDirectDelivery();
    subagentRuns.set(child.runId, child);
    onTestFinished(() => {
      subagentRuns.delete(child.runId);
    });

    expect(await reserveRestoredSubagentControllerSources([child])).toEqual([]);
    await expect(
      withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params)),
    ).resolves.toBe(false);
    expect(startTurn).not.toHaveBeenCalled();
    expect(completeBatch).toHaveBeenCalledWith([child], 1, undefined, expect.any(Function));
    const foreground = vi.fn(async () => "foreground completed");
    await expect(withSessionTurn(REQUESTER_TURN, foreground)).resolves.toBe("foreground completed");
    expect(foreground).toHaveBeenCalledOnce();
  });

  it.each(["superseded sibling", "current killed child"] as const)(
    "restores the same owed yielded cohort as dispatch with a %s",
    async (scenario) => {
      const context = createContext();
      const child = settledChild();
      child.delivery = { status: "pending" };
      const obsolete: SubagentRunRecord = {
        ...settledChild(),
        runId: "superseded-child",
        childSessionKey: "agent:main:subagent:superseded-child",
        completion: {
          ...settledChild().completion,
          required: true,
          resultText: "OBSOLETE-FINDING",
        },
        delivery: { status: "pending" },
        suppressCompletionDelivery: true,
        killReconciliation: { killedAt: 3_000, supersededAt: 4_000 },
      };
      const rows = scenario === "superseded sibling" ? [child, obsolete] : [child];
      if (scenario === "current killed child") {
        child.killReconciliation = { killedAt: 3_000 };
        child.suppressCompletionDelivery = true;
        child.endedReason = SUBAGENT_ENDED_REASON_KILLED;
        child.execution.outcome = { status: "error", error: "synthetic cancellation" };
      }
      for (const row of rows) {
        row.requesterSettleWake = {
          ...row.requesterSettleWake!,
          batchRunIds: rows.map((member) => member.runId).toSorted(),
        };
        subagentRuns.set(row.runId, row);
        onTestFinished(() => {
          subagentRuns.delete(row.runId);
        });
      }
      registryRead.listSubagentRunsForRequester.mockReturnValue(rows);
      const completeBatch = vi.fn<Wake["completeBatch"]>(
        async (batch, _generation, _outcome, committed) => {
          for (const row of batch) {
            row.requesterSettleWake = undefined;
          }
          await committed?.();
        },
      );
      const params = wakeParams(child, completeBatch);
      const received: Array<{ message: string; runId: string }> = [];
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        acceptTurn({ controllerInput, preflight, io });
        await withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
          io.emitExecutionStarted?.();
          received.push({
            message: preflight.request.message,
            runId: preflight.request.idempotencyKey,
          });
        });
        finishProcessedCompletion(io);
      });
      useDirectDelivery();

      const restored = await reserveRestoredSubagentControllerSources(rows);
      expect(restored).toHaveLength(1);
      await expect(
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params)),
      ).resolves.toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]!.message).not.toContain("OBSOLETE-FINDING");
      expect(received[0]!.message).toContain(
        scenario === "superseded sibling" ? "child result" : "synthetic cancellation",
      );
      expect(received[0]!.runId).toBe(
        scenario === "superseded sibling"
          ? "announce:requester-settle:main:agent:main:main:settled-child,superseded-child:yield-1"
          : "announce:requester-settle:main:agent:main:main:settled-child:yield-1",
      );
      expect(completeBatch).toHaveBeenCalledWith(
        rows,
        1,
        expect.objectContaining({ delivered: true }),
        expect.any(Function),
      );
      await expect(
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params)),
      ).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledOnce();
      const foreground = vi.fn(async () => "foreground completed");
      await expect(withSessionTurn(REQUESTER_TURN, foreground)).resolves.toBe(
        "foreground completed",
      );
      expect(foreground).toHaveBeenCalledOnce();
    },
  );

  it("does not dispatch findings whose child becomes superseded after preparation", async () => {
    const context = createContext();
    const { child, completeBatch, params } = dispatchFixture();
    child.delivery = { status: "pending" };
    child.requesterSettleWake!.batchRunIds = [child.runId];
    const prepared = createDeferredCore();
    const release = createDeferredCore();
    readDescendantFacts
      .mockImplementationOnce(async () => ({ unsettled: false, active: 0 }))
      .mockImplementationOnce(async () => {
        // This second read follows the real completion-findings preparation.
        prepared.resolve();
        await release.promise;
        return { unsettled: false, active: 0 };
      });
    const transition = vi.fn(params.transitionBatch);
    startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
      acceptTurn({ controllerInput, preflight, io });
      await withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
        io.emitExecutionStarted?.();
      });
      finishProcessedCompletion(io);
    });
    useDirectDelivery();
    const pending = withGateway(context, () =>
      maybeWakeRequesterAfterAllChildrenSettled({ ...params, transitionBatch: transition }),
    );
    try {
      await prepared.promise;
      // Keep the same row owner and terminal outcome: only latest-execution custody changes.
      child.killReconciliation = { killedAt: 3_000, supersededAt: 4_000 };
      release.resolve();
      await expect(pending).rejects.toThrow(
        "Requester completion source changed before continuation admission.",
      );
      expect(startTurn).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      expect(completeBatch).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });

  it.each([
    { name: "all consumed, NO_REPLY", undelivered: false, silent: true },
    { name: "all consumed, empty reply", undelivered: false, silent: false },
    { name: "one undelivered, NO_REPLY", undelivered: true, silent: true },
  ])(
    "settles a yielded cohort according to its remaining results: $name",
    async ({ undelivered, silent }) => {
      vi.useFakeTimers();
      const context = createContext();
      const consumed = settledChild();
      const sibling = settledChild();
      sibling.runId = "sibling";
      sibling.childSessionKey = "agent:main:subagent:sibling";
      sibling.delivery = { status: undelivered ? "pending" : "delivered" };
      const children = [consumed, sibling];
      for (const child of children) {
        child.requesterSettleWake!.batchRunIds = children.map((entry) => entry.runId);
      }
      registryRead.listSubagentRunsForRequester.mockReturnValue(children);
      const completeBatch = vi.fn<Wake["completeBatch"]>(() => {
        for (const child of children) {
          child.requesterSettleWake = undefined;
        }
      });
      useDirectDelivery();
      startTurn.mockImplementation(async ({ preflight, io }) => {
        acceptTurn({ preflight, io });
        io.emitFinal([
          true,
          {
            status: "ok",
            result: {
              payloads: [],
              meta: { terminalReply: { disposition: silent ? "silent" : "empty" } },
            },
          },
          undefined,
        ]);
      });
      const params = wakeParams(consumed, completeBatch);
      const run = () =>
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));

      await expect(run()).resolves.toBe(!undelivered);
      expect(startTurn).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledTimes(undelivered ? 0 : 1);
      if (undelivered) {
        expect(consumed.requesterSettleWake).toMatchObject({
          status: "pending",
          attemptCount: 1,
          lastError: "completion agent did not produce a visible reply",
        });
        startTurn.mockImplementation(async ({ preflight, io }) => {
          acceptTurn({ preflight, io });
          finishTurn(io, "Remaining child result received.");
        });
      } else {
        expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({ delivered: true });
      }
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(run()).resolves.toBe(undelivered);
      expect(startTurn).toHaveBeenCalledTimes(undelivered ? 2 : 1);
      expect(completeBatch).toHaveBeenCalledOnce();
    },
  );

  it("retains an expired completion until unrelated interrupted requester work recovers", async () => {
    const context = createContext();
    const { child, completeBatch, params } = dispatchFixture();
    child.completionTarget = "parent";
    child.completionRequesterSessionId = "requester-session";
    child.delivery = { status: "suspended", suspendedAt: 4_000, suspendedReason: "expiry" };
    child.requesterSettleWake = { status: "pending", attemptCount: 0, batchRunIds: [child.runId] };
    const retained = structuredClone(child);
    const requester = useDirectDelivery(
      requesterSnapshot(
        {},
        {
          sessionId: "requester-session",
          updatedAt: 1,
          status: "interrupted",
          abortedLastRun: true,
          mainRestartRecovery: { cycleId: "interrupted-cycle", revision: 1, chargedAttempts: 0 },
          restartRecoveryDeliveryRunId: "interrupted-requester-turn",
          restartRecoveryDeliverySourceRunId: "unrelated-completion-wave",
        },
      ),
    );
    loadRequester.mockResolvedValue(requester);
    subagentRuns.set(child.runId, child);
    onTestFinished(() => {
      subagentRuns.delete(child.runId);
    });
    const run = () => withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
    startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
      acceptTurn({ controllerInput, preflight, io });
      await withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
        io.emitExecutionStarted?.();
      });
      finishProcessedCompletion(io);
    });

    expect(await reserveRestoredSubagentControllerSources([child])).toEqual([]);
    await expect(run()).resolves.toBe(false);
    expect(startTurn).not.toHaveBeenCalled();
    expect(completeBatch).not.toHaveBeenCalled();
    expect(child).toEqual(retained);
    expect(
      getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET)?.entries ?? [],
    ).toEqual([]);

    requester.entry = { sessionId: "requester-session", updatedAt: 2, status: "done" };
    await expect(run()).resolves.toBe(true);
    await expect(run()).resolves.toBe(false);
    expect(startTurn).toHaveBeenCalledOnce();
    expect(completeBatch).toHaveBeenCalledOnce();
    expect(child.completion?.resultText).toBe("child result");
  });

  it.each(["requester wake", "ordinary delivery"] as const)(
    "keeps foreground admission available until restored %s is due",
    async (kind) => {
      const child = settledChild();
      setSubagentAnnounceDeliveryDepsForTest({
        getRuntimeConfig: () => ({}),
        loadRequesterSessionEntry: () => requesterSnapshot(),
      });
      const due = Date.now() + 30_000;
      if (kind === "requester wake") {
        child.requesterSettleWake = {
          ...child.requesterSettleWake!,
          attemptCount: 1,
          nextAttemptAt: due,
          batchRunIds: [child.runId],
        };
      } else {
        child.requesterSettleWake = undefined;
        child.delivery = { status: "pending", attemptCount: 1, nextAttemptAt: due };
      }
      subagentRuns.set(child.runId, child);
      onTestFinished(() => {
        subagentRuns.delete(child.runId);
      });
      expect(await reserveRestoredSubagentControllerSources([child])).toEqual([]);
      expect(
        getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET)?.entries ?? [],
      ).toEqual([]);
      const foreground = vi.fn(async () => "foreground completed");
      await expect(withSessionTurn(REQUESTER_TURN, foreground)).resolves.toBe(
        "foreground completed",
      );
      expect(foreground).toHaveBeenCalledOnce();
      const clock = vi.spyOn(Date, "now").mockReturnValue(due);
      try {
        const restored = await reserveRestoredSubagentControllerSources([child]);
        expect(restored).toHaveLength(1);
        expect(restored[0]?.phase).toBe("preparing");
        expect(await reserveRestoredSubagentControllerSources([child])).toEqual(restored);
        expect(
          getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET)?.entries,
        ).toHaveLength(1);
        expect(startTurn).not.toHaveBeenCalled();
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([
    "retry pending",
    "obsolete original pending",
    "retry settled",
    "retry settled claim",
  ] as const)("keeps final-attempt custody with historical receipts: %s", async (scenario) => {
    const stableRunId = "announce:requester-settle:main:agent:main:main:settled-child:yield-1";
    const retryRunId =
      "announce:requester-settle:main:agent:main:main:settled-child:yield-1:retry-2";
    const obsoleteOriginalPending = scenario === "obsolete original pending";
    const pendingRunId = obsoleteOriginalPending ? stableRunId : retryRunId;
    const historicalRunId = obsoleteOriginalPending ? retryRunId : stableRunId;
    const settled = scenario.startsWith("retry settled");
    const reconciled = settled || obsoleteOriginalPending;
    const requesterEntry: InternalSessionEntry = {
      sessionId: "requester-session",
      updatedAt: 1,
      lifecycleRunId: settled ? "recovered-retry" : "recovering-wake",
      ...(scenario === "retry settled claim" ? { abortedLastRun: true } : {}),
      restartRecoveryTerminalRunIds: settled ? [historicalRunId, retryRunId] : [historicalRunId],
      restartRecoveryTerminalDeliveryEvidence: [
        recoveryEvidence(historicalRunId, "historical-attempt", obsoleteOriginalPending),
        ...(settled ? [recoveryEvidence(retryRunId, "recovered-retry")] : []),
      ],
      ...(!settled || scenario === "retry settled claim"
        ? {
            restartRecoveryDeliveryRunId: "recovering-wake",
            restartRecoveryDeliverySourceRunId: pendingRunId,
          }
        : {}),
    };
    const child = settledChild();
    child.requesterSettleWake = {
      ...child.requesterSettleWake!,
      status: "dispatching",
      attemptCount: 3,
      batchRunIds: [child.runId],
    };
    const { completeBatch, params } = dispatchFixture(child);
    const requester = useDirectDelivery(requesterSnapshot({}, requesterEntry));
    loadRequester.mockResolvedValue(requester);
    expect(await reserveRestoredSubagentControllerSources([child])).toEqual([]);
    await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(settled);
    expect(startTurn).not.toHaveBeenCalled();
    expect(completeBatch).toHaveBeenCalledTimes(reconciled ? 1 : 0);
    if (reconciled) {
      // Only the admitted retry's receipt can retire this wake; an obsolete
      // original-key claim cannot retain it or turn its failed receipt into success.
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          directIdempotencyKey: retryRunId,
        }),
      );
      expect(completeBatch).toHaveBeenCalledWith(
        [child],
        1,
        expect.objectContaining({ delivered: settled }),
        expect.any(Function),
      );
    } else {
      expect(deliver).not.toHaveBeenCalled();
      expect(child.requesterSettleWake).toMatchObject({ status: "dispatching", attemptCount: 3 });
    }
    const mailbox = getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET);
    expect(mailbox?.entries ?? []).toEqual([]);
  });

  it.each([false, true])(
    "wakes a nested yielded requester once (child completed before yield=%s)",
    async (afterRequesterYield) => {
      const requesterSessionKey = "agent:main:subagent:middle";
      const requester: SubagentRunRecord = {
        ...settledChild(),
        runId: "yielded-requester",
        childSessionKey: requesterSessionKey,
        pauseReason: "sessions_yield",
        runTimeoutSeconds: 0,
      };
      registryRead.getLatestLiveSubagentRunByChildSessionKey.mockImplementation(
        (sessionKey, matches) =>
          sessionKey === requesterSessionKey && (!matches || matches(requester))
            ? requester
            : undefined,
      );
      const child = settledChild();
      child.delivery = { status: "pending" };
      child.requesterSessionKey = requesterSessionKey;
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [child.runId],
        requesterYieldBatch: true,
        afterRequesterYield: afterRequesterYield ? true : undefined,
        rearmGeneration: 1,
      };
      const { completeBatch, params } = dispatchFixture(child);
      const append = vi.fn(() => true);
      const owner = {
        requesterAgentId: "main",
        requesterSessionKey,
        requesterSessionId: "requester-session",
        requesterTurnRunId: "yielded-requester",
      };
      const attachment = registerRequesterFinalAttachment({
        ...owner,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        timeoutMs: 60_000,
        append,
      });
      onTestFinished(() => attachment.revoke());
      expect(
        promoteRequesterFinalAttachment({
          ...owner,
          batchRunIds: [child.runId],
          rearmGeneration: 1,
        }),
      ).toBe(true);
      const delivered = {
        delivered: true,
        path: "direct",
        finalAssistantVisibleText: "consolidated final",
      } as const;
      deliver.mockResolvedValue(delivered);

      await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(true);
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({
          targetRequesterSessionKey: requesterSessionKey,
          requesterIsSubagent: true,
          requireVisibleReply: true,
          sourceTool: "subagent_settle",
          triggerMessage: expect.stringContaining("child result"),
          directIdempotencyKey: `announce:requester-settle:main:${requesterSessionKey}:${child.runId}:yield-1`,
        }),
      );
      expect(completeBatch).toHaveBeenCalledWith([child], 1, delivered, expect.any(Function));
      expect(append).not.toHaveBeenCalled();
      const onCommitted = completeBatch.mock.calls[0]![3]!;
      await onCommitted();
      await onCommitted();
      expect(append).toHaveBeenCalledExactlyOnceWith(delivered.finalAssistantVisibleText);
      await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(false);
      expect(deliver).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledOnce();
    },
  );

  it("queues a pause notice behind the requester's current turn and delivers it once", async () => {
    vi.useFakeTimers();
    const context = createContext();
    const child = settledChild();
    child.pauseReason = "sessions_yield";
    child.execution.outcome = undefined;
    child.completion = { required: true };
    child.delivery = { status: "pending" };
    child.requesterSettleWake!.pauseNotice = { acknowledgment: "PAUSE-MARKER-mid-turn" };
    registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
    const accepted = createDeferredCore();
    const turnGate = createEnteredGate();
    const received: string[] = [];
    const currentTurn = withSessionTurn(REQUESTER_TURN, turnGate.wait);
    await turnGate.entered;
    startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
      const request = preflight.request;
      acceptTurn({ controllerInput, preflight, io });
      const queued = withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
        io.emitExecutionStarted?.();
        received.push(request.message);
      });
      accepted.resolve();
      await queued;
      finishTurn(io, "Continuation needed.");
    });
    useDirectDelivery();
    const params = wakeParams(child, () => {
      consumeSubagentPauseNotice(child);
    });
    const wake = withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
    try {
      await accepted.promise;
      expect(received).toEqual([]);
      const mailbox = getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET);
      expect({
        activeCount: Number(Boolean(mailbox?.claim)),
        queuedCount: mailbox?.entries.filter((entry) => entry.phase !== "claimed").length ?? 0,
      }).toEqual({ activeCount: 1, queuedCount: 1 });
      turnGate.release();
      await currentTurn;
      await expect(wake).resolves.toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("PAUSE-MARKER-mid-turn");
      expect(received[0]).toContain('"state":"paused"');
      expect(child.pauseReason).toBe("sessions_yield");
      await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledOnce();
    } finally {
      turnGate.release();
      await currentTurn;
      await wake;
    }
  });

  it.each(["unavailable", "admitted", "accepted replay", "ambiguous"] as const)(
    "retains only a definite pre-admission refusal: %s",
    async (failure) => {
      const context = createContext();
      const createFacade = context.createAgentTurnFacade;
      const { child, completeBatch, params } = dispatchFixture();
      const initialWake = structuredClone(child.requesterSettleWake);
      useDirectDelivery();
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        if (failure === "admitted") {
          const registration = registerRequesterTurn({ controllerInput, preflight, io }, 1_000);
          registration.cleanup();
        } else if (failure === "accepted replay") {
          acceptTurn({ controllerInput, preflight, io }, true);
        }
        throw Object.assign(
          new Error("requester dispatch unavailable"),
          failure === "ambiguous" ? { sentBeforeError: true } : {},
        );
      });
      if (failure === "unavailable") {
        context.createAgentTurnFacade = undefined;
      }
      const run = () =>
        withGateway(context, () => maybeWakeRequesterAfterAllChildrenSettled(params));
      await expect(run()).resolves.toBe(false);
      if (failure === "unavailable") {
        expect(startTurn).not.toHaveBeenCalled();
        expect(completeBatch).not.toHaveBeenCalled();
        expect(child.requesterSettleWake).toEqual(initialWake);
        context.createAgentTurnFacade = createFacade;
        startTurn.mockImplementation(async ({ preflight, io }) => {
          io.emitAcceptance([
            true,
            { runId: preflight.request.idempotencyKey, status: "accepted" },
          ]);
          finishTurn(io, "Continuation.");
        });
        await expect(run()).resolves.toBe(true);
      } else {
        expect(completeBatch).toHaveBeenCalledOnce();
        await expect(run()).resolves.toBe(false);
      }
      expect(startTurn).toHaveBeenCalledOnce();
      expect(completeBatch).toHaveBeenCalledOnce();
    },
  );

  it("rejects a replaced anchor after requester wake runtime loading", async () => {
    const retired = settledChild();
    const current = structuredClone(retired);
    registryRead.listSubagentRunsForRequester.mockReturnValue([current]);
    deliver.mockResolvedValue({ delivered: true, path: "direct" });
    const completeBatch = vi.fn();

    await expect(
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams(retired, completeBatch)),
    ).resolves.toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(completeBatch).not.toHaveBeenCalled();
  });

  it.each(["final", "runtime timeout", "stop"] as const)(
    "keeps an executing completion under requester lifecycle ownership: %s",
    async (outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const context = createContext();
      const child = settledChild();
      child.completionRequesterSessionId = "requester-session";
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      const cfg = {
        agents: { defaults: { timeoutSeconds: 1, subagents: { announceTimeoutMs: 20 } } },
      };
      setRuntimeConfigSnapshot(cfg);
      const preparationStarted = createDeferredCore();
      const finishPreparation = createDeferredCore();
      const executionStarted = createDeferredCore();
      const workDone = createDeferredCore();
      const stop = new AbortController();
      const timeoutMs = resolveAgentTimeoutMs({ cfg });
      const timedOut = vi.fn();
      const completeBatch = vi.fn();
      const finalReceipts: string[] = [];
      let acceptedSignal: AbortSignal | undefined;
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        const request = preflight.request as { idempotencyKey: string; sessionKey: string };
        const registration = registerRequesterTurn({ controllerInput, preflight, io }, timeoutMs);
        acceptedSignal = registration.controller.signal;
        try {
          if (!registration.registered) {
            throw new Error("expected requester RPC source");
          }
          io.emitStartOwner?.(request.idempotencyKey, registration.entry);
          preparationStarted.resolve();
          await finishPreparation.promise;
          acceptTurn({ controllerInput, preflight, io });
          await withSessionTurn(
            {
              ...REQUESTER_TURN,
              controllerInput: registration.entry.input,
              abortSignal: registration.controller.signal,
            },
            async (operation) => {
              if (!operation) {
                throw new Error("expected requester operation");
              }
              markReplyOperationExecutionStarted(operation);
              operation.setPhase("running");
              io.emitExecutionStarted?.();
              const timeout = prepareEmbeddedAttemptTimeout({
                attempt: {
                  runId: request.idempotencyKey,
                  sessionId: "requester-session",
                  timeoutMs,
                },
                activeSession: { isCompacting: false, isStreaming: true },
                compactionState: { isCompacting: () => false },
                compactionTimeoutMs: 100,
                runAbortSignal: registration.controller.signal,
                isProbeSession: true,
                abortRun: () => registration.controller.abort(new Error("requester run timed out")),
                markTimedOutDuringCompaction: vi.fn(),
                markTimedOutByRunBudget: timedOut,
              });
              executionStarted.resolve();
              try {
                await waitForGatewayDispatch(
                  "synthetic requester work",
                  workDone.promise,
                  undefined,
                  registration.controller.signal,
                );
                finalReceipts.push("consolidated requester final");
              } finally {
                timeout.clearTimers();
              }
            },
          );
          finishTurn(io, finalReceipts[0]);
        } finally {
          const claim = registration.entry?.input.claim;
          registration.cleanup();
          await registration.entry?.input.settlement.promise;
          await claim?.settlement.promise;
        }
      });
      useDirectDelivery(requesterSnapshot(cfg));
      const wake = withGateway(context, () =>
        maybeWakeRequesterAfterAllChildrenSettled({
          ...wakeParams(child, completeBatch),
          signal: stop.signal,
        }),
      );
      let settled = false;
      void wake.then(() => {
        settled = true;
      });
      try {
        await preparationStarted.promise;
        await vi.advanceTimersByTimeAsync(21);
        expect(settled).toBe(false);
        expect(acceptedSignal?.aborted).toBe(false);
        finishPreparation.resolve();
        expect(
          await Promise.race([executionStarted.promise.then(() => true), wake.then(() => false)]),
        ).toBe(true);
        await vi.advanceTimersByTimeAsync(21);
        expect(acceptedSignal?.aborted).toBe(false);
        expect(finalReceipts).toEqual([]);
        expect(completeBatch).not.toHaveBeenCalled();
        if (outcome === "final") {
          workDone.resolve();
        } else if (outcome === "runtime timeout") {
          await vi.advanceTimersByTimeAsync(timeoutMs);
        } else {
          stop.abort(new Error("requester stopped"));
        }
        await expect(wake).resolves.toBe(outcome === "final");
        expect(startTurn).toHaveBeenCalledOnce();
        expect(deliver).toHaveBeenCalledOnce();
        expect(timedOut).toHaveBeenCalledTimes(outcome === "runtime timeout" ? 1 : 0);
        expect(finalReceipts).toEqual(outcome === "final" ? ["consolidated requester final"] : []);
        if (outcome === "final") {
          expect(completeBatch).toHaveBeenCalledWith(
            [child],
            1,
            expect.objectContaining({ delivered: true, requesterVisibleFinalDelivered: true }),
            expect.any(Function),
          );
        } else if (outcome === "runtime timeout") {
          // The requester consumed the continuation; its failed outcome is recorded once.
          expect(acceptedSignal?.aborted).toBe(true);
          expect(completeBatch).toHaveBeenCalledOnce();
          expect(completeBatch.mock.calls[0]?.[2]).toMatchObject({ delivered: false });
        } else {
          // A stopped evaluation leaves the durable wake owed.
          expect(acceptedSignal?.aborted).toBe(true);
          expect(completeBatch).not.toHaveBeenCalled();
          expect(child.requesterSettleWake).toBeDefined();
        }
        const later = vi.fn();
        let laterClaim: ReturnType<typeof getCurrentSessionControllerClaim>;
        await withSessionTurn(REQUESTER_TURN, async () => {
          laterClaim = getCurrentSessionControllerClaim();
          later();
        });
        await laterClaim?.settlement.promise;
        expect(later).toHaveBeenCalledOnce();
        const mailbox = getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET);
        expect(mailbox?.claim).toBeUndefined();
        expect(mailbox?.entries ?? []).toEqual([]);
        expect(rpcSourceTesting.size).toBe(0);
        expect(child.execution.outcome).toEqual({ status: "ok" });
        expect(child.completion?.resultText).toBe("child result");
      } finally {
        finishPreparation.resolve();
        workDone.resolve();
        stop.abort();
        await wake;
      }
    },
  );
});
