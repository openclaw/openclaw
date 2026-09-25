import { expect, it, vi } from "vitest";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { dispatchGatewayMethodInProcess } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { createContext as createGatewayContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { withGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
      SubagentLifecycleOptions,
      "runSubagentAnnounceFlow" | "persistOrThrow"
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
      persistOrThrow: () => {
        if (entry.cleanupCompletedAt !== undefined) {
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
            expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(true);
          },
        ),
    );

    const dispatchResult = expect(dispatchFinished.promise).resolves.toEqual(delivered);
    disposed = true;
    releaseCleanup();

    await dispatchResult;
    await cleanupFinished.promise;
    expect(freshTranscriptWrite).toHaveBeenCalledOnce();
    expect(entry.delivery?.status).toBe("delivered");
    expect(requesterTranscriptWrite).not.toHaveBeenCalled();
    expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
  });
}
