import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
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
    vi.useRealTimers();
  });

  it("preserves the approval budget through the production attempt entrypoint", async () => {
    vi.useRealTimers();
    const originalDateNow = Date.now;
    let wallClockOffsetMs = 0;
    Date.now = () => originalDateNow() + wallClockOffsetMs;
    const publishedDeadlines: Array<{ kind: string; deadlineAtMs?: number }> = [];

    try {
      const result = await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:telegram:direct:approval-clock-step",
        tempPaths,
        sessionPrompt: async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          wallClockOffsetMs = 60_000;
          emitAgentEvent({
            runId: "run-context-engine-forwarding",
            sessionId: "embedded-session",
            stream: "lifecycle",
            data: { phase: "waiting-approval", approvalId: "clock-step" },
          });
          emitAgentEvent({
            runId: "run-context-engine-forwarding",
            sessionId: "embedded-session",
            stream: "lifecycle",
            data: { phase: "approval-resolved", approvalId: "clock-step" },
          });
          await new Promise((resolve) => setTimeout(resolve, 80));
        },
        attemptOverrides: {
          timeoutMs: 250,
          onAttemptDeadlineChanged: (deadline) => publishedDeadlines.push(deadline),
        },
      });

      expect(result.terminal).toEqual({ kind: "ok" });
      expect(publishedDeadlines.map(({ kind }) => kind)).toEqual([
        "bounded",
        "unlimited",
        "bounded",
      ]);
      expect(publishedDeadlines[2]?.deadlineAtMs).toBeGreaterThan(
        (publishedDeadlines[0]?.deadlineAtMs ?? 0) + 59_000,
      );
      process.stdout.write(
        `REAL_BEHAVIOR_PROOF terminal=ok deadlineKinds=${publishedDeadlines.map(({ kind }) => kind).join(",")} ` +
          `resumedDeadlineDeltaMs=${(publishedDeadlines[2]?.deadlineAtMs ?? 0) - (publishedDeadlines[0]?.deadlineAtMs ?? 0)}\n`,
      );
    } finally {
      Date.now = originalDateNow;
    }
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
});
