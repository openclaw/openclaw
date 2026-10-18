import "./subagent-announce.requester-settle-dispatch-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { registerChatAbortController } from "../../../gateway/chat-abort.js";
import { waitForGatewayDispatch } from "../../../gateway/server-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../../sessions/session-controller.admission.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerClaim,
} from "../../../sessions/session-controller.lifecycle.js";
import { getExistingSessionControllerMailbox } from "../../../sessions/session-controller.mailbox.js";
import { markReplyOperationExecutionStarted } from "../../../sessions/session-controller.state.js";
import { rpcSourceTesting } from "../../../sessions/session-lifecycle-admission.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { prepareEmbeddedAttemptTimeout } from "../../embedded-agent-runner/run/attempt-timeout-prepare.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import { consumeSubagentPauseNotice } from "../registry/subagent-delivery-state.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  registerRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import { reserveRestoredSubagentControllerSources } from "./subagent-announce-controller-source.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import { setSubagentAnnounceDeliveryDepsForTest } from "./subagent-announce-overrides.test-support.js";
import {
  deliver,
  loadRequester,
  registryRead,
  startTurn,
  REQUESTER_KEY,
  settledChild,
  publishWakeTransition,
  useRequesterSettleDispatchFixture,
  createRequesterSettleContext as createContext,
} from "./subagent-announce.requester-settle-dispatch.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
    clearRuntimeConfigSnapshot();
  }),
);

const REQUESTER_TARGET = captureSessionTarget({
  storeScope: "/synthetic/requester-settle-dispatch/sessions.db",
  sessionKey: REQUESTER_KEY,
  incarnation: "requester-session",
  agentId: "main",
});
const REQUESTER_TURN = {
  target: REQUESTER_TARGET,
  sessionKey: REQUESTER_KEY,
  sessionId: "requester-session",
  agentId: "main",
};

describe("requester settle dispatch deadline", () => {
  useRequesterSettleDispatchFixture();

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
  });

  it.each(["requester wake", "ordinary delivery"] as const)(
    "keeps foreground admission available until restored %s is due",
    async (kind) => {
      const child = settledChild();
      setSubagentAnnounceDeliveryDepsForTest({
        getRuntimeConfig: () => ({}),
        loadRequesterSessionEntry: () => ({
          cfg: {},
          canonicalKey: REQUESTER_KEY,
          agentId: "main",
          storePath: REQUESTER_TARGET.storeScope,
          entry: { sessionId: "requester-session", updatedAt: 1 },
        }),
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
  ] as const)("keeps restored retry custody with historical receipts: %s", async (scenario) => {
    const stableRunId = "announce:requester-settle:main:agent:main:main:settled-child:yield-1";
    const retryRunId =
      "announce:requester-settle:main:agent:main:main:settled-child:yield-1:retry-1";
    const obsoleteOriginalPending = scenario === "obsolete original pending";
    const pendingRunId = obsoleteOriginalPending ? stableRunId : retryRunId;
    const historicalRunId = obsoleteOriginalPending ? retryRunId : stableRunId;
    const settled = scenario.startsWith("retry settled");
    const reconciled = settled || obsoleteOriginalPending;
    const requesterEntry: InternalSessionEntry = {
      sessionId: "requester-session",
      updatedAt: 1,
      lifecycleRunId: settled ? "recovered-retry" : "recovering-wake",
      restartRecoveryTerminalRunIds: settled ? [historicalRunId, retryRunId] : [historicalRunId],
      restartRecoveryTerminalDeliveryEvidence: [
        {
          runId: historicalRunId,
          transcriptRunId: "historical-attempt",
          captured: true,
          ...(obsoleteOriginalPending
            ? { meta: { error: true } }
            : {
                payloads: [{ visible: true }],
                deliveryStatus: { status: "sent" as const, resultCount: 1 },
              }),
        },
        ...(settled
          ? [
              {
                runId: retryRunId,
                transcriptRunId: "recovered-retry",
                captured: true as const,
                payloads: [{ visible: true }],
                deliveryStatus: { status: "sent" as const, resultCount: 1 },
              },
            ]
          : []),
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
      attemptCount: 2,
      batchRunIds: [child.runId],
    };
    registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
    const readRequester = () => ({
      cfg: {},
      canonicalKey: REQUESTER_KEY,
      agentId: "main",
      storePath: REQUESTER_TARGET.storeScope,
      entry: requesterEntry,
    });
    loadRequester.mockImplementation(async () => readRequester());
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig: () => ({}),
      loadRequesterSessionEntry: readRequester,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session",
        target: REQUESTER_TARGET,
        isActive: false,
      }),
    });
    deliver.mockImplementation(sendSubagentAnnounceDirectly);
    const completeBatch = vi.fn(() => {
      child.requesterSettleWake = undefined;
    });
    expect(await reserveRestoredSubagentControllerSources([child])).toEqual([]);
    await expect(
      maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: REQUESTER_KEY,
        isSourceCurrent: () => true,
        settledEntry: child,
        transitionBatch: publishWakeTransition,
        completeBatch,
      }),
    ).resolves.toBe(settled);
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
      expect(child.requesterSettleWake).toMatchObject({ status: "dispatching", attemptCount: 2 });
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
      child.requesterSessionKey = requesterSessionKey;
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: [child.runId],
        requesterYieldBatch: true,
        afterRequesterYield: afterRequesterYield ? true : undefined,
        rearmGeneration: 1,
      };
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
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
      const completeBatch = vi.fn<
        Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]["completeBatch"]
      >((batch) => {
        for (const entry of batch) {
          entry.requesterSettleWake = undefined;
        }
      });
      const params = {
        isSourceCurrent: () => true,
        requesterSessionKey,
        settledEntry: child,
        transitionBatch: publishWakeTransition,
        completeBatch,
      };

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
      onCommitted();
      onCommitted();
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
    const releaseTurn = createDeferredCore();
    const currentTurnStarted = createDeferredCore();
    const received: string[] = [];
    const currentTurn = withSessionTurn(REQUESTER_TURN, async () => {
      currentTurnStarted.resolve();
      await releaseTurn.promise;
    });
    await currentTurnStarted.promise;
    startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
      const request = preflight.request;
      io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }], {
        runId: request.idempotencyKey,
      });
      const queued = withSessionTurn({ ...REQUESTER_TURN, controllerInput }, async () => {
        io.emitExecutionStarted?.();
        received.push(request.message);
      });
      accepted.resolve();
      await queued;
      io.emitFinal([
        true,
        { status: "ok", result: { payloads: [{ text: "Continuation needed." }] } },
      ]);
    });
    setSubagentAnnounceDeliveryDepsForTest({
      getRuntimeConfig: () => ({}),
      loadRequesterSessionEntry: () => ({
        cfg: {},
        canonicalKey: REQUESTER_KEY,
        agentId: "main",
        storePath: REQUESTER_TARGET.storeScope,
        entry: { sessionId: "requester-session", updatedAt: 1 },
      }),
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session",
        target: REQUESTER_TARGET,
        isActive: false,
      }),
    });
    deliver.mockImplementation(sendSubagentAnnounceDirectly);
    const params = {
      requesterSessionKey: REQUESTER_KEY,
      isSourceCurrent: () => true,
      settledEntry: child,
      transitionBatch: publishWakeTransition,
      completeBatch: () => {
        consumeSubagentPauseNotice(child);
      },
    };
    const wake = withPluginRuntimeGatewayRequestScope(
      { context, client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
      () => maybeWakeRequesterAfterAllChildrenSettled(params),
    );
    try {
      await accepted.promise;
      expect(received).toEqual([]);
      const mailbox = getExistingSessionControllerMailbox(REQUESTER_KEY, REQUESTER_TARGET);
      expect({
        activeCount: Number(Boolean(mailbox?.claim)),
        queuedCount: mailbox?.entries.filter((entry) => entry.phase !== "claimed").length ?? 0,
      }).toEqual({ activeCount: 1, queuedCount: 1 });
      releaseTurn.resolve();
      await currentTurn;
      await expect(wake).resolves.toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain("PAUSE-MARKER-mid-turn");
      expect(received[0]).toContain('"state":"paused"');
      expect(child.pauseReason).toBe("sessions_yield");
      await expect(maybeWakeRequesterAfterAllChildrenSettled(params)).resolves.toBe(false);
      expect(startTurn).toHaveBeenCalledOnce();
    } finally {
      releaseTurn.resolve();
      await currentTurn;
      await wake;
    }
  });

  it.each(["unavailable", "admitted", "accepted replay", "ambiguous"] as const)(
    "retains only a definite pre-admission refusal: %s",
    async (failure) => {
      const context = createContext();
      const createFacade = context.createAgentTurnFacade;
      const child = settledChild();
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      const initialWake = structuredClone(child.requesterSettleWake);
      const completeBatch = vi.fn(() => {
        child.requesterSettleWake = undefined;
      });
      const params = {
        requesterSessionKey: REQUESTER_KEY,
        isSourceCurrent: () => true,
        settledEntry: child,
        transitionBatch: publishWakeTransition,
        completeBatch,
      };
      setSubagentAnnounceDeliveryDepsForTest({
        getRuntimeConfig: () => ({}),
        loadRequesterSessionEntry: () => ({
          cfg: {},
          canonicalKey: REQUESTER_KEY,
          agentId: "main",
          storePath: REQUESTER_TARGET.storeScope,
          entry: { sessionId: "requester-session", updatedAt: 1 },
        }),
        getRequesterSessionActivity: () => ({
          sessionId: "requester-session",
          target: REQUESTER_TARGET,
          isActive: false,
        }),
      });
      deliver.mockImplementation(sendSubagentAnnounceDirectly);
      startTurn.mockImplementation(async ({ controllerInput, preflight, io }) => {
        const request = preflight.request;
        if (failure === "admitted") {
          const registration = registerChatAbortController({
            target: REQUESTER_TARGET,
            runId: request.idempotencyKey,
            sessionId: "requester-session",
            sessionKey: REQUESTER_KEY,
            timeoutMs: 1_000,
            kind: "agent",
            sourceInput: controllerInput,
          });
          registration.cleanup();
        } else if (failure === "accepted replay") {
          io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }], {
            runId: request.idempotencyKey,
            cached: true,
          });
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
        withPluginRuntimeGatewayRequestScope(
          { context, client: createSyntheticPluginRuntimeClient(), isWebchatConnect: () => false },
          () => maybeWakeRequesterAfterAllChildrenSettled(params),
        );
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
          io.emitFinal([true, { status: "ok", result: { payloads: [{ text: "Continuation." }] } }]);
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
      maybeWakeRequesterAfterAllChildrenSettled({
        isSourceCurrent: () => true,
        requesterSessionKey: REQUESTER_KEY,
        settledEntry: retired,
        transitionBatch: publishWakeTransition,
        completeBatch,
      }),
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
      registryRead.listSubagentRunsForRequester.mockReturnValue([child]);
      const cfg = {
        agents: { defaults: { timeoutSeconds: 1, subagents: { announceTimeoutMs: 20 } } },
      };
      setRuntimeConfigSnapshot(cfg);
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
        const registration = registerChatAbortController({
          target: REQUESTER_TARGET,
          runId: request.idempotencyKey,
          sessionId: "requester-session",
          sessionKey: request.sessionKey,
          timeoutMs,
          kind: "agent",
          sourceInput: controllerInput,
        });
        acceptedSignal = registration.controller.signal;
        io.emitAcceptance([true, { runId: request.idempotencyKey, status: "accepted" }], {
          runId: request.idempotencyKey,
        });
        try {
          if (!registration.registered) {
            throw new Error("expected requester RPC source");
          }
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
          io.emitFinal([
            true,
            { status: "ok", result: { payloads: [{ text: finalReceipts[0] }] } },
          ]);
        } finally {
          const claim = registration.entry?.input.claim;
          registration.cleanup();
          await registration.entry?.input.settlement.promise;
          await claim?.settlement.promise;
        }
      });
      setSubagentAnnounceDeliveryDepsForTest({
        getRuntimeConfig: () => cfg,
        loadRequesterSessionEntry: () => ({
          cfg,
          canonicalKey: REQUESTER_KEY,
          agentId: "main",
          storePath: REQUESTER_TARGET.storeScope,
          entry: { sessionId: "requester-session", updatedAt: 1 },
        }),
        getRequesterSessionActivity: () => ({
          sessionId: "requester-session",
          target: REQUESTER_TARGET,
          isActive: false,
        }),
      });
      deliver.mockImplementation(sendSubagentAnnounceDirectly);
      const wake = withPluginRuntimeGatewayRequestScope(
        {
          context,
          client: createSyntheticPluginRuntimeClient(),
          isWebchatConnect: () => false,
        },
        () =>
          maybeWakeRequesterAfterAllChildrenSettled({
            isSourceCurrent: () => true,
            requesterSessionKey: REQUESTER_KEY,
            settledEntry: child,
            signal: stop.signal,
            transitionBatch: publishWakeTransition,
            completeBatch,
          }),
      );
      try {
        await executionStarted.promise;
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
        workDone.resolve();
        stop.abort();
        await wake;
      }
    },
  );
});
