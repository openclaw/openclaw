import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

it.each(["admitted", "read-error", "failed", "failed-read-error", "failed-cancelled"] as const)(
  "settles the recovery observer and unsubscribes after %s",
  async (outcome) => {
    vi.useFakeTimers();
    const scope = { storePath: "/fixture/sessions.json", sessionKey: "agent:main:main" };
    const initial = {
      sessionId: "fixture-session",
      updatedAt: 1,
      abortedLastRun: true,
      status: "running" as const,
    };
    const read = vi.mocked(loadSessionEntry).mockReturnValue(initial);
    const runtime = createRecoveryRuntimeFixture({
      callGateway: vi.fn(async () => {
        throw new Error("Unexpected Gateway call");
      }),
      getDispatchSettlement: async () => {},
      sendRecoveryNotice: async () => ({ suppressed: false }),
    });
    const failure = new Error("fixture database read failed");
    const settled = vi.fn();
    const failedRecovery = outcome.startsWith("failed");
    const cleanup = createDeferred();
    const stop = vi.fn(() => cleanup.promise);
    const cancellation = new AbortController();
    const observation = failedRecovery
      ? runtime.expectFailedRecovery(0, { stop }, cancellation.signal, scope)
      : runtime.expectAdmission(0, scope);
    const pending = observation.then(
      () => settled("finished"),
      (error: unknown) => settled(error),
    );
    try {
      if (outcome.endsWith("cancelled")) {
        cancellation.abort(failure);
      } else if (outcome.endsWith("read-error")) {
        read.mockImplementationOnce(() => {
          throw failure;
        });
      } else {
        read.mockReturnValue({
          ...initial,
          abortedLastRun: false,
          ...(failedRecovery ? { status: "failed" as const } : {}),
        });
      }
      sessionChanges.emit(scope);
      await vi.advanceTimersByTimeAsync(0);

      if (failedRecovery) {
        expect(stop).toHaveBeenCalledOnce();
        expect(settled).not.toHaveBeenCalled();
        cleanup.resolve();
        await pending;
      }

      expect(settled).toHaveBeenCalledExactlyOnceWith(
        outcome.endsWith("read-error") || outcome.endsWith("cancelled") ? failure : "finished",
      );
      read.mockClear();
      sessionChanges.emit(scope);
      expect(read).not.toHaveBeenCalled();
    } finally {
      // Let the original broken observer settle after the intended assertion fails.
      read.mockReturnValue({ ...initial, abortedLastRun: false, status: "failed" });
      cleanup.resolve();
      sessionChanges.emit(scope);
      await pending;
    }
  },
);
