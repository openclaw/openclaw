import { expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../../packages/gateway-client/src/request-error.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../../config/sessions/lifecycle.js";
import type { callGateway as CallGateway } from "../../../gateway/call.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createRunEntry,
  readLifecycleRun,
  type LifecycleControllerFixtureOptions,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerDeleteCleanupRetentionTests({
  createLifecycleController,
}: {
  createLifecycleController: (
    params: LifecycleControllerFixtureOptions,
  ) => SubagentLifecycleController;
}) {
  const target = { sessionId: "original-child", lifecycleRevision: "original-revision" };
  it("retains completed delete receipts after requester settlement and emits its context tail", async () => {
    const entry = createRunEntry({ cleanup: "delete", endedAt: 4_000, archiveAtMs: 304_000 });
    const runs = new Map([[entry.runId, entry]]);
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({ entry, runs, notifyContextEngineSubagentEnded });
    const join = observeRootWork();
    await controller.completeCleanupBookkeeping({
      runId: entry.runId,
      entry,
      cleanup: "delete",
      completedAt: 5_000,
    });
    await join();
    expect(runs.get(entry.runId)).toMatchObject({
      archiveAtMs: 304_000,
      cleanupCompletedAt: 5_000,
    });
    expect(readLifecycleRun(entry).requesterSettleWake).toBeUndefined();
    expect(notifyContextEngineSubagentEnded).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionKey: entry.childSessionKey, reason: "deleted" }),
      expect.objectContaining({
        isCurrent: expect.any(Function),
        prepareCurrent: expect.any(Function),
      }),
    );
  });
  it("retries a delivered delete only with its original persisted physical target", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      endedAt: 4_000,
      deleteCleanupDispatchedAt: 3_000,
      deleteCleanupTarget: target,
      delivery: { status: "delivered" },
    });
    const callGateway = vi.fn<typeof CallGateway>().mockResolvedValue({});
    const runSubagentAnnounceFlow = vi.fn(async () => "delivered" as const);
    const controller = createLifecycleController({
      entry,
      // SAFETY: this delete-only fixture ignores the generic reply; the spy returns an empty ACK.
      callGateway: callGateway as typeof CallGateway,
      runSubagentAnnounceFlow,
    });
    const join = observeRootWork();
    controller.startSubagentAnnounceCleanupFlow(entry);
    await join();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          expectedSessionId: target.sessionId,
          expectedLifecycleRevision: target.lifecycleRevision,
        }),
      }),
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
  });
  it.each(["delivered", "legacy-stamp"] as const)(
    "fails closed for a %s delete without a complete original target",
    async (kind) => {
      const entry = createRunEntry({
        cleanup: "delete",
        endedAt: 4_000,
        ...(kind === "delivered"
          ? { delivery: { status: "delivered" as const } }
          : { deleteCleanupDispatchedAt: 3_000, expectsCompletionMessage: false }),
      });
      const callGateway = vi.fn<typeof CallGateway>().mockResolvedValue({});
      const controller = createLifecycleController({
        entry,
        // SAFETY: identity-less cleanup must not invoke this empty-ACK delete fixture.
        callGateway: callGateway as typeof CallGateway,
      });
      const join = observeRootWork();
      controller.startSubagentAnnounceCleanupFlow(entry);
      await join();
      expect(callGateway).not.toHaveBeenCalled();
      expect(readLifecycleRun(entry)).toMatchObject({
        cleanupCompletedAt: expect.any(Number),
        execution: { suppressSessionEffects: true },
      });
    },
  );
  it("publishes a changed-session fence before completing the retained cleanup", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      endedAt: 4_000,
      deleteCleanupDispatchedAt: 3_000,
      deleteCleanupTarget: target,
      delivery: { status: "delivered" },
    });
    const callGateway = vi.fn(async () => {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "changed",
        details: { reason: SESSION_LIFECYCLE_CHANGED_ERROR_REASON },
      });
    });
    const notifyContextEngineSubagentEnded = vi.fn(async () => {});
    const controller = createLifecycleController({
      entry,
      callGateway,
      notifyContextEngineSubagentEnded,
    });
    const join = observeRootWork();
    controller.startSubagentAnnounceCleanupFlow(entry);
    await join();
    const completed = readLifecycleRun(entry);
    expect(completed.execution.suppressSessionEffects).toBe(true);
    expect(completed.deleteCleanupTarget).toBeUndefined();
    expect(completed.deleteCleanupDispatchedAt).toBeUndefined();
    expect(completed.cleanupCompletedAt).toBeTypeOf("number");
    expect(notifyContextEngineSubagentEnded).not.toHaveBeenCalled();
  });
  it("captures the delete target durably before delivery and retains it when receipt publication fails", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      endedAt: 4_000,
      expectsCompletionMessage: true,
      completion: { required: true, resultText: "completed result" },
      endedReason: "subagent-complete",
      outcome: { status: "ok" },
    });
    const deliverySeen = createDeferredCore();
    let targetBeforeDelivery: SubagentRunRecord["deleteCleanupTarget"];
    const runSubagentAnnounceFlow = vi.fn<
      NonNullable<LifecycleControllerFixtureOptions["runSubagentAnnounceFlow"]>
    >(async (params) => {
      targetBeforeDelivery = readLifecycleRun(entry).deleteCleanupTarget;
      try {
        await params.onDeliveryResult?.({
          delivered: true,
          path: "direct",
          disposition: "delivered",
        });
      } finally {
        deliverySeen.resolve();
      }
      return "delivered";
    });
    const controller = createLifecycleController({
      entry,
      runSubagentAnnounceFlow,
      beforeWrite: ({ postimages }) => {
        if (postimages.get(entry.runId)?.delivery?.status === "delivered") {
          throw new Error("receipt publication failed");
        }
      },
    });
    const join = observeRootWork();
    controller.startSubagentAnnounceCleanupFlow(entry);
    await deliverySeen.promise;
    await join();
    expect(targetBeforeDelivery).toEqual({
      sessionId: "child-session-id",
      lifecycleRevision: "child-lifecycle-revision",
    });
    expect(readLifecycleRun(entry).deleteCleanupTarget).toEqual(targetBeforeDelivery);
    expect(readLifecycleRun(entry).delivery?.status).not.toBe("delivered");
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
  });
  it("does not finish targetless optional give-up before its durable suppression fence commits", async () => {
    const entry = createRunEntry({
      cleanup: "delete",
      endedAt: 4_000,
      expectsCompletionMessage: false,
    });
    const controller = createLifecycleController({
      entry,
      beforeWrite: ({ postimages }) => {
        if (postimages.get(entry.runId)?.execution.suppressSessionEffects) {
          throw new Error("suppression publication failed");
        }
      },
    });
    await expect(
      controller.finalizeResumedAnnounceGiveUp({ entry, reason: "expiry" }),
    ).rejects.toThrow("suppression publication failed");
    expect(readLifecycleRun(entry).cleanupCompletedAt).toBeUndefined();
    expect(readLifecycleRun(entry).execution.suppressSessionEffects).toBeUndefined();
  });
  it.each([false, true])(
    "resumes only current ancestors after retained delete cleanup (cycle=%s)",
    async (cycle) => {
      const ancestor = createRunEntry({
        runId: "ancestor-current",
        childSessionKey: "agent:main:subagent:ancestor",
        requesterSessionKey: cycle ? "agent:main:subagent:parent" : "agent:main:main",
        generation: 2,
        endedAt: Date.now(),
        expectsCompletionMessage: true,
        pauseReason: "sessions_yield",
        wakeOnDescendantSettle: true,
      });
      const previous = createRunEntry({ ...ancestor, runId: "ancestor-previous", generation: 1 });
      const parent = createRunEntry({
        runId: "parent",
        childSessionKey: "agent:main:subagent:parent",
        requesterSessionKey: ancestor.childSessionKey,
        endedAt: Date.now(),
        cleanupCompletedAt: Date.now(),
      });
      const settled = createRunEntry({
        runId: "settled",
        requesterSessionKey: parent.childSessionKey,
        endedAt: Date.now(),
      });
      const unrelated = createRunEntry({
        runId: "unrelated",
        childSessionKey: "agent:main:subagent:unrelated",
        endedAt: Date.now(),
      });
      const runs = new Map(
        [ancestor, previous, parent, settled, unrelated].map((entry) => [entry.runId, entry]),
      );
      const resumeSubagentRun = vi.fn();
      const controller = createLifecycleController({ entry: settled, runs, resumeSubagentRun });

      await controller.completeCleanupBookkeeping({
        runId: settled.runId,
        entry: settled,
        cleanup: "delete",
        completedAt: Date.now(),
        preserveTranscript: true,
        skipRequesterSettleWake: true,
      });

      expect(runs.get(settled.runId)?.cleanupCompletedAt).toBeTypeOf("number");
      expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(ancestor.runId);
    },
  );
}
