import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_PROMPT } from "../../../auto-reply/heartbeat.js";
import { limitHistoryTurns } from "../history.js";
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
      attemptOverrides: {
        bootstrapContextMode: "full",
        bootstrapContextRunKind: "default",
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

  it("filters no-op heartbeat pairs before history limiting and context-engine assembly", async () => {
    hoisted.getDmHistoryLimitFromSessionKeyMock.mockReturnValue(1);
    hoisted.limitHistoryTurnsMock.mockImplementation(
      (messages: unknown, limit: number | undefined) =>
        limitHistoryTurns(messages as AgentMessage[], limit),
    );
    const assemble = vi.fn(async ({ messages }: { messages: AgentMessage[] }) => ({
      messages,
      estimatedTokens: 1,
    }));
    const sessionMessages: AgentMessage[] = [
      { role: "user", content: "real question", timestamp: 1 } as unknown as AgentMessage,
      { role: "assistant", content: "real answer", timestamp: 2 } as unknown as AgentMessage,
      { role: "user", content: HEARTBEAT_PROMPT, timestamp: 3 } as unknown as AgentMessage,
      { role: "assistant", content: "HEARTBEAT_OK", timestamp: 4 } as unknown as AgentMessage,
    ];

    await createContextEngineAttemptRunner({
      contextEngine: { assemble },
      attemptOverrides: {
        config: {
          agents: {
            list: [{ id: "main", heartbeat: {} }],
          },
        },
      },
      sessionKey: "agent:main:discord:dm:test-user",
      sessionMessages,
      tempPaths,
    });

    expect(assemble).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({ role: "user", content: "real question" }),
          expect.objectContaining({ role: "assistant", content: "real answer" }),
        ],
      }),
    );
  });
});
