import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { AgentRunTerminalOutcomeError } from "../../agent-run-terminal-error.js";
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

  it.each([
    { label: "cancellation", timeout: false },
    { label: "timeout", timeout: true },
  ])(
    "does not create attempt resources after external $label during paired-computer discovery",
    async ({ timeout }) => {
      const discovery = createDeferred();
      const abortController = new AbortController();
      const reason = new Error(
        timeout
          ? "timed out during paired-computer discovery"
          : "cancelled during paired-computer discovery",
      );
      reason.name = timeout ? "TimeoutError" : "AbortError";
      let discoverySignal: AbortSignal | undefined;
      hoisted.loadPairedComputerUseAvailabilityForSurfaceMock.mockImplementation((input) => {
        discoverySignal = (input as { signal?: AbortSignal }).signal;
        return discovery.promise;
      });

      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:triage:deferred-computer",
        tempPaths,
        sessionPrompt: async () => {},
        attemptOverrides: {
          abortSignal: abortController.signal,
          config: { tools: { codeMode: true } },
          disableTools: false,
          forceCodeModeTools: true,
          sessionTarget: {
            agentId: "main",
            expectedWriterRunId: "run-context-engine-forwarding",
            sessionId: "embedded-session",
            sessionKey: "agent:main:triage:deferred-computer",
            storePath: "/tmp/openclaw-unused-aborted-transcript.sqlite",
          },
        },
      });

      await vi.waitFor(() =>
        expect(hoisted.loadPairedComputerUseAvailabilityForSurfaceMock).toHaveBeenCalledTimes(1),
      );
      expect(discoverySignal).toBeDefined();
      abortController.abort(reason);
      expect(discoverySignal?.aborted).toBe(true);
      expect(discoverySignal?.reason).toBe(reason);
      discovery.resolve();

      if (timeout) {
        let thrown: unknown;
        try {
          await attempt;
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(AgentRunTerminalOutcomeError);
        const timeoutError = thrown as AgentRunTerminalOutcomeError;
        expect(timeoutError.cause).toBe(reason);
        expect(timeoutError.terminalOutcome).toMatchObject({ status: "timeout" });
      } else {
        await expect(attempt).rejects.toBe(reason);
      }
      expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
      expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
      expect(hoisted.bindCodeModeTranscriptAuthorityMock).not.toHaveBeenCalled();
    },
  );

  it("propagates an ordinary paired-computer discovery failure without creating resources", async () => {
    const reason = new Error("paired-computer discovery failed");
    let discoverySignal: AbortSignal | undefined;
    hoisted.loadPairedComputerUseAvailabilityForSurfaceMock.mockImplementation((input) => {
      discoverySignal = (input as { signal?: AbortSignal }).signal;
      throw reason;
    });

    const attempt = createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:triage:failed-computer",
      tempPaths,
      sessionPrompt: async () => {},
      attemptOverrides: {
        config: { tools: { codeMode: true } },
        disableTools: false,
        forceCodeModeTools: true,
      },
    });

    await expect(attempt).rejects.toBe(reason);
    expect(discoverySignal?.aborted).toBe(false);
    expect(hoisted.createOpenClawCodingToolsMock).not.toHaveBeenCalled();
    expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
    expect(hoisted.bindCodeModeTranscriptAuthorityMock).not.toHaveBeenCalled();
  });
});
