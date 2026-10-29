import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import { useContextEngineAttemptHarness } from "./attempt-context-engine.test-support.js";
const { hoisted, runAttempt } = useContextEngineAttemptHarness("agent:main:triage:cleanup");

it.each(["projection", "construction"])("joins cleanup after %s fails", async (stage) => {
  const cleanupFails = stage === "construction";
  const preparationError = new Error("tool preparation failed");
  const held = createDeferred();
  const started = createDeferred();
  const cleanupScope = createAgentCleanupScope();
  let toolSignal: AbortSignal | undefined;
  const cleanup = vi.fn(async (_reason: string) => {
    started.resolve();
    await held.promise;
    if (cleanupFails) {
      throw new Error("registered resource teardown failed");
    }
  });
  hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
    toolSignal = options?.abortSignal;
    expectDefined(options?.registerRunCleanup, "cleanup registrar")(cleanup);
    if (stage === "construction") {
      throw preparationError;
    }
    return [
      {
        get name(): string {
          throw preparationError;
        },
      },
    ];
  });
  const attempt = cleanupScope.run(() =>
    runAttempt({
      sessionKey: "agent:main:triage:failed-tool-preparation",
      attemptOverrides: {
        oneShotCliRun: true,
        disableTools: false,
      },
    }),
  );
  const settled = vi.fn();
  const result = attempt.catch(() => {}).finally(settled);
  try {
    expect(
      await Promise.race([
        started.promise.then(() => "cleanup-started"),
        result.then(() => "settled"),
      ]),
    ).toBe("cleanup-started");
    expect(settled).not.toHaveBeenCalled();
    expect(toolSignal?.aborted).toBe(true);
    expect(cleanup).toHaveBeenCalledExactlyOnceWith("error");
    held.resolve();
    await expect(attempt).rejects.toBe(preparationError);
    expect(cleanupScope.outcome).toBe(cleanupFails ? "uncertain" : "closed");
    expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
  } finally {
    held.resolve();
    await result;
  }
});

it("bounds registered one-shot cleanup after a completed turn", async () => {
  const held = createDeferred();
  const started = createDeferred();
  const cleanupScope = createAgentCleanupScope();
  hoisted.createOpenClawCodingToolsMock.mockImplementation((options) => {
    const register = expectDefined(options?.registerRunCleanup, "cleanup");
    register(async () => {
      started.resolve();
      await held.promise;
    });
    return [];
  });
  const attempt = cleanupScope.run(() =>
    runAttempt({
      sessionPrompt: async () => {
        vi.useFakeTimers();
      },
      attemptOverrides: { oneShotCliRun: true, disableTools: false },
    }),
  );
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cleanupScope.outcome).toBe("uncertain");
    expect((await attempt).terminal).toEqual({ kind: "ok" });
  } finally {
    held.resolve();
    await attempt;
    vi.useRealTimers();
  }
});

it("preserves a run-budget timeout when abort blocks prompt submission", async () => {
  const pendingEvents = createDeferred();
  const baseSubscribe = expectDefined(
    hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation(),
    "embedded subscription mock",
  );
  hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => ({
    ...baseSubscribe(params),
    waitForPendingEvents: async () => await pendingEvents.promise,
  }));

  const result = await runAttempt({
    sessionKey: "agent:main:telegram:direct:timeout",
    sessionPrompt: async () => {},
    attemptOverrides: {
      timeoutMs: 20,
      onAttemptTimeout: () => pendingEvents.resolve(),
    },
  });

  expect(result.terminal).toMatchObject({ kind: "timeout" });
});
