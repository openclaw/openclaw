import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createTestSession } from "../../sessions/agent-session-loop-correctness.test-support.js";
import { prepareCatalogExecutor } from "./attempt-stream-prepare.test-support.js";

/** Uses the owning stream suite's registration and session lifecycle. */
export function registerPreparationSteeringTests() {
  it.each([true, false])(
    "withdraws preparation-time steering on closure (wait for commit: %s)",
    async (waitForTranscriptCommit) => {
      const { session } = await createTestSession();
      vi.useFakeTimers();
      const prepared = prepareCatalogExecutor({ activeSession: session });
      const abort = new AbortController();
      const accepted = createDeferredCore<boolean>();
      const settled = vi.fn();
      await session.steer("unrelated control");
      const receipt = prepared.queueHandle
        .queueMessage("queued during preparation", {
          waitForTranscriptCommit,
          abortSignal: abort.signal,
          onQueueAccepted: accepted.resolve,
          onQueueSettled: settled,
        })
        .then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
      try {
        await expect(accepted.promise).resolves.toBe(true);
        expect(settled).not.toHaveBeenCalled();
        prepared.stopAcceptingSteerMessages();
        await vi.advanceTimersByTimeAsync(0);

        expect(settled).toHaveBeenCalledOnce();
        expect(session.getSteeringMessages()).toEqual(["unrelated control"]);
        expect(await receipt).toEqual({
          error: waitForTranscriptCommit
            ? expect.objectContaining({ name: "MessageInjectionWithdrawnError" })
            : undefined,
        });
        expect(prepared.queueHandle.isAborted?.()).toBe(false);
      } finally {
        abort.abort();
        await vi.advanceTimersByTimeAsync(0);
        await receipt;
        prepared.subscription.unsubscribe();
        vi.useRealTimers();
      }
    },
  );
}
