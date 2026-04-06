import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt context injection", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("skips bootstrap reinjection on safe continuation turns when configured", async () => {
    hoisted.resolveContextInjectionModeMock.mockReturnValue("continuation-skip");
    hoisted.hasCompletedBootstrapTurnMock.mockResolvedValue(true);

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      sessionKey: "agent:main",
      tempPaths,
    });

    expect(hoisted.hasCompletedBootstrapTurnMock).toHaveBeenCalled();
    expect(hoisted.resolveBootstrapContextForRunMock).not.toHaveBeenCalled();
  });

  it("checks continuation state only after taking the session lock", async () => {
    hoisted.resolveContextInjectionModeMock.mockReturnValue("continuation-skip");
    hoisted.hasCompletedBootstrapTurnMock.mockResolvedValue(true);

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      sessionKey: "agent:main",
      tempPaths,
    });

    expect(hoisted.acquireSessionWriteLockMock).toHaveBeenCalled();
    expect(hoisted.hasCompletedBootstrapTurnMock).toHaveBeenCalled();
    const lockCallOrder = hoisted.acquireSessionWriteLockMock.mock.invocationCallOrder[0];
    const continuationCallOrder = hoisted.hasCompletedBootstrapTurnMock.mock.invocationCallOrder[0];
    expect(lockCallOrder).toBeLessThan(continuationCallOrder);
  });

  it("still resolves bootstrap context when continuation-skip has no completed assistant turn yet", async () => {
    hoisted.resolveContextInjectionModeMock.mockReturnValue("continuation-skip");
    hoisted.hasCompletedBootstrapTurnMock.mockResolvedValue(false);

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      sessionKey: "agent:main",
      tempPaths,
    });

    expect(hoisted.resolveBootstrapContextForRunMock).toHaveBeenCalledTimes(1);
  });

  it("never skips heartbeat bootstrap filtering", async () => {
    hoisted.resolveContextInjectionModeMock.mockReturnValue("continuation-skip");
    hoisted.hasCompletedBootstrapTurnMock.mockResolvedValue(true);

    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      attemptOverrides: {
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "heartbeat",
      },
      sessionKey: "agent:main:heartbeat:test",
      tempPaths,
    });

    expect(hoisted.hasCompletedBootstrapTurnMock).not.toHaveBeenCalled();
    expect(hoisted.resolveBootstrapContextForRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contextMode: "lightweight",
        runKind: "heartbeat",
      }),
    );
  });

  it("records full bootstrap completion after a successful non-heartbeat turn", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      sessionKey: "agent:main",
      tempPaths,
    });

    expect(hoisted.sessionManager.appendCustomEntry).toHaveBeenCalledWith(
      "openclaw:bootstrap-context:full",
      expect.objectContaining({
        runId: "run-context-engine-forwarding",
        sessionId: "embedded-session",
      }),
    );
  });

  it("does not record full bootstrap completion for heartbeat runs", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      attemptOverrides: {
        bootstrapContextMode: "lightweight",
        bootstrapContextRunKind: "heartbeat",
      },
      sessionKey: "agent:main:heartbeat:test",
      tempPaths,
    });

    expect(hoisted.sessionManager.appendCustomEntry).not.toHaveBeenCalledWith(
      "openclaw:bootstrap-context:full",
      expect.anything(),
    );
  });
});
