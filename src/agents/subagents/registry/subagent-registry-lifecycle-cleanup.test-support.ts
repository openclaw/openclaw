import { expect, it, vi, type Mock } from "vitest";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import type { CallGatewayOptions } from "../../../gateway/call.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
} from "./subagent-lifecycle-events.js";
import {
  readLifecycleRun,
  type createRunEntry as createLifecycleRunEntry,
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

export function registerDetachedCleanupAuthorityTest({
  createRunEntry,
  createLifecycleController,
}: {
  createRunEntry: (params: {
    requesterSessionKey: string;
    endedAt: number;
    expectsCompletionMessage: boolean;
    retainAttachmentsOnKeep: boolean;
  }) => SubagentRunRecord;
  createLifecycleController: (
    params: { entry: SubagentRunRecord } & Pick<
      LifecycleControllerFixtureOptions,
      "runSubagentAnnounceFlow" | "beforeWrite"
    >,
  ) => Pick<SubagentLifecycleController, "startSubagentAnnounceCleanupFlow">;
}) {
  it("delivers detached cleanup after its requester tool and transcript owners retire", async () => {
    const sessionKey = "agent:main:disposed-cleanup-owner";
    const entry = createRunEntry({
      requesterSessionKey: sessionKey,
      endedAt: 4_000,
      expectsCompletionMessage: true,
      retainAttachmentsOnKeep: true,
    });
    let disposed = false;
    let releaseCleanup!: () => void;
    const cleanupReady = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const freshTranscriptWrite = vi.fn(async () => {});
    const gatewayContext = createGatewayContext();
    const idempotencyKey = "detached-cleanup-delivery";
    const delivered = { runId: "cleanup-delivery", status: "ok" };
    gatewayContext.dedupe.set(`agent:${idempotencyKey}`, {
      ts: Date.now(),
      ok: true,
      payload: delivered,
    });
    const dispatchFinished = createDeferredCore<unknown>();
    const cleanupFinished = createDeferredCore();
    const runSubagentAnnounceFlow = vi.fn(async () => {
      await cleanupReady;
      try {
        const result = await dispatchGatewayMethodInProcess(
          "agent",
          { message: "Deliver the completed child result.", idempotencyKey },
          {
            expectFinal: true,
            forceSyntheticClient: true,
            resolveGatewayContext: () => gatewayContext,
          },
        );
        await runWithOwnedSessionTranscriptWrite({ sessionKey }, freshTranscriptWrite);
        dispatchFinished.resolve(result);
      } catch (error) {
        dispatchFinished.reject(error);
        throw error;
      }
      return "delivered" as const;
    });
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      beforeWrite: ({ postimages }) => {
        if (postimages.get(entry.runId)?.cleanupCompletedAt !== undefined) {
          cleanupFinished.resolve();
        }
      },
    });

    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operationalRunInstance:
          createTestAdmittedRunContext("cleanup-requester").operationalRunInstance,
        receiptAuthority: () => !disposed,
      },
      () =>
        withOwnedSessionTranscriptWrites(
          { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
          async () => {
            expect(controller.startSubagentAnnounceCleanupFlow(entry)).toBe(true);
          },
        ),
    );

    const dispatchResult = expect(dispatchFinished.promise).resolves.toEqual(delivered);
    disposed = true;
    releaseCleanup();

    await dispatchResult;
    await cleanupFinished.promise;
    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(readLifecycleRun(entry).delivery?.status).toBe("delivered");
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
  });
}

export function registerDirectSessionCleanupAuthorityTests({
  createRunEntry,
  createLifecycleController,
  completeRun,
  completeAndJoinCleanup,
  gatewayMocks,
  helperMocks,
  sessionEntryReadMocks,
  waitForLifecycleState,
}: {
  createRunEntry: typeof createLifecycleRunEntry;
  createLifecycleController: (
    options: { entry: SubagentRunRecord } & Partial<LifecycleControllerFixtureOptions>,
  ) => SubagentLifecycleController;
  completeRun: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options: Pick<SubagentCompletionRequest, "triggerCleanup" | "sessionEffects">,
  ) => Promise<void>;
  completeAndJoinCleanup: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options: Pick<SubagentCompletionRequest, "triggerCleanup" | "sessionEffects" | "terminalReply">,
  ) => Promise<void>;
  gatewayMocks: {
    callGateway: Mock<(options: CallGatewayOptions) => Promise<Record<string, unknown>>>;
  };
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
  sessionEntryReadMocks: { loadSessionEntryByKey: Mock };
  waitForLifecycleState: (assertion: () => void) => Promise<void>;
}) {
  it("commits cancellation of a yielded run before browser cleanup", async () => {
    const entry = createRunEntry({ expectsCompletionMessage: false });
    expect(markSubagentRunPausedAfterYield({ entry, endedAt: 3_000 })).toBe(true);
    let persisted: SubagentRunRecord | undefined;
    let committedBeforeCleanup = false;
    const cleanupBrowser = vi.fn(async () => {
      committedBeforeCleanup = persisted?.endedReason === SUBAGENT_ENDED_REASON_KILLED;
    });
    const controller = createLifecycleController({
      entry,
      beforeWrite: ({ postimages }) => {
        const postimage = postimages.get(entry.runId);
        if (postimage) {
          persisted = structuredClone(postimage);
        }
      },
      cleanupBrowserSessionsForLifecycleEnd: cleanupBrowser,
    });

    await controller.completeSubagentRun({
      runId: entry.runId,
      endedAt: 4_000,
      outcome: { status: "error", error: "operator cancelled" },
      reason: SUBAGENT_ENDED_REASON_KILLED,
      triggerCleanup: true,
    });

    expect(persisted).toMatchObject({
      endedReason: SUBAGENT_ENDED_REASON_KILLED,
      execution: {
        status: "terminal",
        endedAt: 4_000,
        outcome: { status: "error", error: "operator cancelled" },
      },
      killReconciliation: { killedAt: 4_000 },
    });
    expect(persisted?.pauseReason).toBeUndefined();
    expect(cleanupBrowser).toHaveBeenCalledOnce();
    expect(committedBeforeCleanup).toBe(true);
  });

  it("allows terminal effects after a rejected recovery supplied a retired child guard", async () => {
    const entry = createRunEntry();
    const emitProgress = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      emitSubagentProgressEndedForRun: emitProgress,
    });
    const prepareRecoveryCurrent = vi.fn(async () => false);
    const assertRetired = () => {
      throw new Error("Recovery no longer owns the child session");
    };
    await controller.completeSubagentRun({
      runId: entry.runId,
      expectedEntry: entry,
      outcome: { status: "error", error: "rejected recovery" },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      triggerCleanup: false,
      recoverInterrupted: true,
      recoveryCurrent: {
        prepare: prepareRecoveryCurrent,
        isHostCurrent: () => true,
      },
      sessionEffects: {
        isCurrent: async () => false,
        assertHostCurrent: assertRetired,
        assertCurrentEntry: assertRetired,
      },
    });
    expect(prepareRecoveryCurrent).toHaveBeenCalledOnce();
    expect(readLifecycleRun(entry).execution.status).toBe("running");
    expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
    expect(emitProgress).not.toHaveBeenCalled();

    await completeRun(controller, entry, { triggerCleanup: false });

    expect(readLifecycleRun(entry).execution.status).toBe("terminal");
    expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
    expect(emitProgress).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ runId: entry.runId, childSessionKey: entry.childSessionKey }),
    );
  });

  it("keeps direct delete cleanup root-admitted until the gateway call settles", async () => {
    const entry = createRunEntry({ cleanup: "delete", expectsCompletionMessage: false });
    const runs = new Map([[entry.runId, entry]]);
    let releaseDelete: (() => void) | undefined;
    gatewayMocks.callGateway.mockImplementation((opts) => {
      if (opts.method !== "sessions.delete") {
        return Promise.resolve({});
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        releaseDelete = () => resolve({});
      });
    });
    const controller = createLifecycleController({ entry, runs });

    await completeRun(controller, entry, { triggerCleanup: true });
    await waitForLifecycleState(() => expect(releaseDelete).toBeTypeOf("function"));
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    releaseDelete?.();
    await waitForLifecycleState(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    expect(runs.has(entry.runId)).toBe(false);
  });

  it("settles direct cleanup when the child changes during its deletion identity read", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      expectsCompletionMessage: false,
      suppressCompletionDelivery: true,
    });
    const runs = new Map([[entry.runId, entry]]);
    let current = true;
    sessionEntryReadMocks.loadSessionEntryByKey.mockImplementationOnce(async () => {
      current = false;
      return { sessionId: "child-session-id", lifecycleRevision: "child-lifecycle-revision" };
    });
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Child session changed");
      }
    };
    let finalPostimage: SubagentRunRecord | undefined;
    const controller = createLifecycleController({
      entry,
      runs,
      beforeWrite: ({ postimages }) => {
        const postimage = postimages.get(entry.runId);
        if (postimage) {
          finalPostimage = postimage;
        }
      },
    });

    await completeAndJoinCleanup(controller, entry, {
      triggerCleanup: true,
      sessionEffects: {
        isCurrent: async () => current,
        assertHostCurrent: assertCurrent,
        assertCurrentEntry: assertCurrent,
      },
    });

    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(finalPostimage?.execution.status).toBe("terminal");
    expect(finalPostimage?.execution.suppressSessionEffects).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });
}

export function registerDeliveredCleanupEndedHookTest({
  createRunEntry,
  createLifecycleController,
  completeAndJoinCleanup,
}: Pick<
  Parameters<typeof registerDirectSessionCleanupAuthorityTests>[0],
  "createRunEntry" | "createLifecycleController" | "completeAndJoinCleanup"
>) {
  it("emits ended hook while retrying cleanup after completion was already delivered", async () => {
    const entry = createRunEntry({
      delivery: { status: "delivered", announcedAt: 3_500, deliveredAt: 3_500 },
      endedAt: 4_000,
      expectsCompletionMessage: true,
    });
    const emitSubagentEndedHookForRun = vi.fn(async () => {});

    const controller = createLifecycleController({
      entry,
      shouldEmitEndedHookForRun: () => true,
      emitSubagentEndedHookForRun,
    });

    await expect(
      completeAndJoinCleanup(controller, entry, {
        triggerCleanup: true,
        terminalReply: { disposition: "visible", text: "final completion reply" },
      }),
    ).resolves.toBeUndefined();

    expect(emitSubagentEndedHookForRun).toHaveBeenCalledTimes(1);
    expect(emitSubagentEndedHookForRun).toHaveBeenCalledWith({
      entry: expect.objectContaining({
        runId: entry.runId,
        childSessionKey: entry.childSessionKey,
        delivery: expect.objectContaining({ status: "delivered", deliveredAt: 3_500 }),
      }),
      reason: SUBAGENT_ENDED_REASON_COMPLETE,
      sendFarewell: true,
      isCurrent: expect.any(Function),
      prepareCurrent: expect.any(Function),
    });
  });
}
