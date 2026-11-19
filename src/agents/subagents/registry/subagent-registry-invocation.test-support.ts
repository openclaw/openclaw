import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import {
  runWithOwnedSessionTranscriptWrite,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { PluginInstanceUnavailableError } from "../../../plugins/plugin-instance-error.js";
import { PluginInstance } from "../../../plugins/plugin-instance.js";
import { PluginInvocationScope } from "../../../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  readLifecycleRun,
  type LifecycleTestDrivers,
  type CompleteLifecycleRun,
} from "./subagent-registry-lifecycle-controller.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";

export function registerInvocationLifecycleCases({
  createRunEntry,
  createLifecycleController,
  completeRun,
  finishCleanup,
}: Pick<LifecycleTestDrivers, "createRunEntry" | "createLifecycleController"> & {
  completeRun: CompleteLifecycleRun;
  finishCleanup: (
    controller: ReturnType<LifecycleTestDrivers["createLifecycleController"]>,
    entry: ReturnType<LifecycleTestDrivers["createRunEntry"]>,
  ) => ReturnType<
    ReturnType<LifecycleTestDrivers["createLifecycleController"]>["completeCleanupBookkeeping"]
  >;
}) {
  it.each(["completion", "announce cleanup"] as const)(
    "runs independent %s after the spawning plugin invocation closes",
    async (phase) => {
      const instance = new PluginInstance("detached-lifecycle");
      const scope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
      const continuation = scope.run(() => AsyncLocalStorage.snapshot());
      const managedCall = instance.wrap(() => "detached completion result");
      const beforeWrite = vi.fn(() => {
        expect(managedCall()).toBe("detached completion result");
      });
      const runSubagentAnnounceFlow = vi.fn(async () => {
        expect(managedCall()).toBe("detached completion result");
        return "delivered" as const;
      });
      const entry = createRunEntry({
        expectsCompletionMessage: phase === "announce cleanup",
        ...(phase === "announce cleanup"
          ? {
              endedAt: Date.now(),
              outcome: { status: "ok" as const },
              completion: { required: true, resultText: "detached completion result" },
            }
          : {}),
      });
      const controller = createLifecycleController({
        entry,
        beforeWrite,
        runSubagentAnnounceFlow,
      });
      const join = observeRootWork();
      try {
        scope.release();
        expect(() => continuation(managedCall)).toThrow("Plugin invocation scope is closed");
        if (phase === "completion") {
          await continuation(() =>
            completeRun(controller, entry, {
              endedAt: Date.now(),
              terminalReply: { disposition: "visible", text: "detached completion result" },
            }),
          );
          expect(beforeWrite).toHaveBeenCalled();
          expect(readLifecycleRun(entry).completion?.resultText).toBe("detached completion result");
        } else {
          expect(continuation(() => controller.startSubagentAnnounceCleanupFlow(entry))).toBe(true);
        }
        await join();
        if (phase === "announce cleanup") {
          expect(runSubagentAnnounceFlow).toHaveBeenCalledOnce();
          expect(readLifecycleRun(entry).cleanupCompletedAt).toBeTypeOf("number");
        }
        // The handoff removes only caller scope; a retired plugin is still unavailable.
        instance.quiesce();
        expect(managedCall).toThrow(PluginInstanceUnavailableError);
      } finally {
        scope.release();
        await join();
        await instance.dispose();
      }
    },
  );

  it("runs a detached settle wake outside disposed requester transcript and plugin scopes", async () => {
    const sessionKey = "agent:main:disposed-settle-wake-owner";
    const entry = createRunEntry({ requesterSessionKey: sessionKey, endedAt: 4_000 });
    let disposed = false;
    const wakeReady = createDeferredCore();
    const requesterTranscriptWrite = vi.fn();
    const withRequesterTranscriptWrite = async <T>(operation: () => Promise<T> | T): Promise<T> => {
      requesterTranscriptWrite();
      if (disposed) {
        throw new Error("attempt disposed before transcript write");
      }
      return await operation();
    };
    const instance = new PluginInstance("detached-requester-wake");
    const invocationScope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
    const continuation = invocationScope.run(() => AsyncLocalStorage.snapshot());
    const freshTranscriptWrite = vi.fn(async () => {});
    const managedWrite = instance.wrap(freshTranscriptWrite);
    const settleWake = vi.fn(async () => {
      await wakeReady.promise;
      await runWithOwnedSessionTranscriptWrite({ sessionKey }, managedWrite);
      return false;
    });
    const controller = createLifecycleController({
      entry,
      maybeWakeRequesterAfterAllChildrenSettled: settleWake,
    });

    const join = observeRootWork();
    try {
      await continuation(() =>
        withOwnedSessionTranscriptWrites(
          { sessionKey, withTranscriptWrite: withRequesterTranscriptWrite },
          () => finishCleanup(controller, entry),
        ),
      );

      disposed = true;
      invocationScope.release();
      expect(() => continuation(managedWrite)).toThrow("Plugin invocation scope is closed");
      wakeReady.resolve();
      await join();

      expect(freshTranscriptWrite).toHaveBeenCalledOnce();
      expect(requesterTranscriptWrite).not.toHaveBeenCalled();
      expect(settleWake).toHaveBeenCalledOnce();
    } finally {
      wakeReady.resolve();
      invocationScope.release();
      await join();
      await instance.dispose();
    }
  });
}
