import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { buildAgentRunTerminalOutcomeFromAttempt } from "../../agent-run-terminal-outcome.js";
import { createAgentCleanupScope } from "../../run-cleanup-timeout.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

describe("runEmbeddedAttempt abort races", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { stage: "construction", cleanupFails: false },
    { stage: "projection", cleanupFails: false },
    { stage: "construction", cleanupFails: true },
  ])(
    "joins cleanup after $stage fails (cleanupFails=$cleanupFails)",
    async ({ stage, cleanupFails }) => {
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
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options: unknown) => {
        const toolOptions = options as {
          abortSignal: AbortSignal;
          registerRunCleanup: (cleanup: (reason: string) => Promise<void>) => void;
        };
        toolSignal = toolOptions.abortSignal;
        toolOptions.registerRunCleanup(cleanup);
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
        createContextEngineAttemptRunner({
          contextEngine: createContextEngineBootstrapAndAssemble(),
          sessionKey: "agent:main:triage:failed-tool-preparation",
          tempPaths,
          attemptOverrides: {
            oneShotCliRun: true,
            disableTools: false,
            forceRestartSafeTools: stage === "projection",
          },
        }),
      );
      let settled = false;
      const result = attempt
        .then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        )
        .then((outcome) => {
          settled = true;
          return outcome;
        });
      try {
        expect(
          await Promise.race([
            started.promise.then(() => "cleanup-started"),
            result.then((outcome) => outcome.kind),
          ]),
        ).toBe("cleanup-started");
        expect(settled).toBe(false);
        expect(toolSignal?.aborted).toBe(true);
        expect(cleanup).toHaveBeenCalledExactlyOnceWith("error");
        held.resolve();
        const outcome = await result;
        expect(outcome.kind).toBe("rejected");
        if (outcome.kind === "rejected") {
          expect(outcome.error).toBe(preparationError);
        }
        expect(cleanupScope.outcome).toBe(cleanupFails ? "uncertain" : "closed");
        expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await result;
      }
    },
  );

  it.each([false, true])(
    "bounds registered one-shot cleanup after a completed turn (fails=%s)",
    async (fails) => {
      const held = createDeferred();
      const started = createDeferred();
      const cleanupScope = createAgentCleanupScope();
      hoisted.createOpenClawCodingToolsMock.mockImplementation((options: unknown) => {
        (
          options as { registerRunCleanup: (cleanup: () => Promise<void>) => void }
        ).registerRunCleanup(async () => {
          started.resolve();
          await held.promise;
          if (fails) {
            throw new Error("registered resource teardown failed");
          }
        });
        return [];
      });
      const attempt = cleanupScope.run(() =>
        createContextEngineAttemptRunner({
          contextEngine: createContextEngineBootstrapAndAssemble(),
          sessionKey: "agent:main:triage:cleanup",
          tempPaths,
          sessionPrompt: async () => {
            vi.useFakeTimers();
          },
          attemptOverrides: { oneShotCliRun: true, disableTools: false },
        }),
      );
      try {
        await started.promise;
        if (fails) {
          held.resolve();
        }
        await vi.advanceTimersByTimeAsync(10_000);
        expect(cleanupScope.outcome).toBe("uncertain");
        expect((await attempt).terminal).toEqual({ kind: "ok" });
      } finally {
        held.resolve();
        await attempt;
        vi.useRealTimers();
      }
    },
  );

  it("preserves a run-budget timeout when abort blocks prompt submission", async () => {
    let releasePendingEvents!: () => void;
    const pendingEvents = new Promise<void>((resolve) => {
      releasePendingEvents = resolve;
    });
    const baseSubscribe = hoisted.subscribeEmbeddedAgentSessionMock.getMockImplementation();
    if (!baseSubscribe) {
      throw new Error("missing embedded subscription mock");
    }
    hoisted.subscribeEmbeddedAgentSessionMock.mockImplementation((params) => ({
      ...baseSubscribe(params),
      waitForPendingEvents: async () => await pendingEvents,
    }));

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:telegram:direct:timeout",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: {
        timeoutMs: 20,
        onAttemptTimeout: () => releasePendingEvents(),
      },
    });

    // The abort-blocked prompt release no longer unwinds the attempt: the run
    // settles so after-turn side effects still fire, and the run-budget
    // timeout attribution survives on the resolved terminal.
    const result = await attempt;

    expect(result.terminal).toMatchObject({ kind: "timeout" });
    expect(buildAgentRunTerminalOutcomeFromAttempt({ terminal: result.terminal })).toMatchObject({
      status: "timeout",
    });
  });
});
