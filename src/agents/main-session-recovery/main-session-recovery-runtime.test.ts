import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
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

it.each([false, true])(
  "waits for both physical stores sharing a session key (reverse=%s)",
  async (reverse) => {
    vi.useFakeTimers();
    const scopes = ["ops", " ops "].map((directory) => ({
      storePath: `/fixture/agents/${directory}/sessions/sessions.json`,
      sessionKey: "agent:ops:main",
    }));
    const entries = new Map<string, SessionEntry>(
      scopes.map((scope, index) => [
        scope.storePath,
        { sessionId: `session-${index}`, updatedAt: 1, status: "running", abortedLastRun: true },
      ]),
    );
    vi.mocked(loadSessionEntry).mockImplementation((scope) => {
      if (!scope.storePath) {
        throw new Error("Expected a physical recovery store");
      }
      return entries.get(scope.storePath);
    });
    const runtime = createRecoveryRuntimeFixture({
      callGateway: vi.fn(async () => {
        throw new Error("Unexpected Gateway call");
      }),
      getDispatchSettlement: async () => {},
      sendRecoveryNotice: async () => ({ suppressed: false }),
    });
    const cancellation = new AbortController();
    const stop = vi.fn(async () => {});
    const observed = vi.fn();
    const pending = runtime
      .expectFailedRecovery(0, { stop }, cancellation.signal, ...scopes)
      .then(observed);
    const complete = (scope: (typeof scopes)[number]) => {
      const entry = entries.get(scope.storePath);
      if (!entry) {
        throw new Error("Missing recovery fixture row");
      }
      entries.set(scope.storePath, { ...entry, status: "failed", abortedLastRun: false });
      sessionChanges.emit(scope);
    };
    try {
      const ordered = reverse ? scopes.toReversed() : scopes;
      for (const [index, scope] of ordered.entries()) {
        complete(scope);
        await vi.advanceTimersByTimeAsync(0);
        if (index === 0) {
          expect(observed).not.toHaveBeenCalled();
          expect(stop).not.toHaveBeenCalled();
        }
      }
      await pending;
      expect(observed).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      scopes.forEach(complete);
      await pending;
    }
  },
);
