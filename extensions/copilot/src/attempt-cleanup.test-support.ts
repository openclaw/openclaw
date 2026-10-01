import { expectDefined } from "@openclaw/normalization-core/expect";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { runCopilotAttempt } from "./attempt.js";
import {
  makeAssistantMessageEvent,
  makeFakePool,
  makeFakeSdk,
  projectAgentRunAttemptTerminal,
  type FakeSdk,
  type FakeSession,
} from "./attempt.test-support.js";

export function registerCopilotCleanupTests({
  makeParams,
  requireSession,
}: {
  makeParams: (
    overrides?: Pick<AgentHarnessAttemptParamsV2, "onAgentEvent">,
  ) => AgentHarnessAttemptParamsV2;
  requireSession: (sdk: FakeSdk) => FakeSession;
}) {
  it.each([false, true])(
    "detaches listeners and joins accepted agent callbacks before cleanup (deferred: %s)",
    async (deferred) => {
      const callbackStarted = createDeferred<void>();
      const releaseCallback = createDeferred<void>();
      const listenersDetached = createDeferred<void>();
      const sendFailure = new Error("send failed after an accepted agent event");
      const onAgentEvent = vi.fn(async () => {
        callbackStarted.resolve();
        await releaseCallback.promise;
      });
      const sdk = makeFakeSdk((session) => {
        const off = expectDefined(session.off.getMockImplementation(), "session unsubscribe");
        session.off.mockImplementationOnce((...args) => {
          off(...args);
          listenersDetached.resolve();
        });
        session.sendAndWait.mockImplementationOnce(async () => {
          session.emit("user.message", { content: "hello" });
          if (deferred) {
            session.emit("session.compaction_start", {});
            return makeAssistantMessageEvent("done");
          }
          session.emit("session.plan_changed", { operation: "update" });
          throw sendFailure;
        });
      });
      const pool = makeFakePool(sdk);
      const onDeferredCompaction = vi.fn<(params: { cleanup: Promise<unknown> }) => void>();
      const attempt = runCopilotAttempt(makeParams({ onAgentEvent }), {
        pool,
        onDeferredCompaction,
      });
      let cleanup: Promise<unknown> = attempt;
      try {
        if (deferred) {
          expect((await attempt).terminal).toEqual({ kind: "ok" });
          cleanup = expectDefined(
            onDeferredCompaction.mock.calls[0]?.[0].cleanup,
            "deferred cleanup",
          );
          const session = requireSession(sdk);
          session.emit("session.plan_changed", { operation: "update" });
          session.emit("session.compaction_complete", { success: true });
          session.emit("session.idle", {});
        }
        await callbackStarted.promise;
        await listenersDetached.promise;
        const session = requireSession(sdk);
        expect(session.off).toHaveBeenCalledTimes(session.on.mock.calls.length);
        expect(session.disconnect).not.toHaveBeenCalled();
        expect(pool.release).not.toHaveBeenCalled();
        session.emit("session.plan_changed", { operation: "update" });
      } finally {
        releaseCallback.resolve();
        await cleanup;
      }
      expect(onAgentEvent).toHaveBeenCalledOnce();
      expect(requireSession(sdk).disconnect).toHaveBeenCalledOnce();
      expect(pool.release).toHaveBeenCalledOnce();
      if (!deferred) {
        expect(projectAgentRunAttemptTerminal((await attempt).terminal).promptError).toBe(
          sendFailure,
        );
      }
    },
  );
}
