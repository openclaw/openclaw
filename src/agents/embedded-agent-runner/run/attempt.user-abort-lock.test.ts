import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  createDefaultEmbeddedSession,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const tempPaths: string[] = [];

beforeEach(() => {
  resetEmbeddedAttemptHarness();
});

afterEach(async () => {
  await cleanupTempPaths(tempPaths);
});

describe("embedded attempt user abort lock release", () => {
  it("releases the retained session lock before cleanup after user abort", async () => {
    const hoisted = getHoisted();
    const lockEvents: string[] = [];
    let lockCount = 0;
    hoisted.acquireSessionWriteLockMock.mockReset().mockImplementation(async () => {
      lockCount += 1;
      const lockId = lockCount;
      lockEvents.push(`acquire-${lockId}`);
      return {
        release: async () => {
          lockEvents.push(`release-${lockId}`);
        },
      };
    });

    let markPromptStarted!: () => void;
    const promptStarted = new Promise<void>((resolve) => {
      markPromptStarted = resolve;
    });
    let settlePrompt!: () => void;
    const promptCanSettle = new Promise<void>((resolve) => {
      settlePrompt = resolve;
    });
    const abortController = new AbortController();
    const contextEngine = createContextEngineBootstrapAndAssemble();

    const run = createContextEngineAttemptRunner({
      contextEngine,
      sessionKey: "agent:main:user-abort-lock",
      tempPaths,
      createSession: () =>
        createDefaultEmbeddedSession({
          prompt: async () => {
            markPromptStarted();
            await promptCanSettle;
          },
        }),
      attemptOverrides: {
        abortSignal: abortController.signal,
      },
    });

    await promptStarted;
    abortController.abort(new Error("user abort"));
    settlePrompt();

    await run;

    const retainedReleaseIndex = lockEvents.indexOf("release-1");
    const cleanupAcquireIndex = lockEvents.indexOf("acquire-2");
    expect(retainedReleaseIndex).toBeGreaterThan(-1);
    expect(cleanupAcquireIndex).toBeGreaterThan(-1);
    expect(retainedReleaseIndex).toBeLessThan(cleanupAcquireIndex);
  });
});
