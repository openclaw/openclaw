import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createDefaultEmbeddedSession,
  getHoisted,
  resetEmbeddedAttemptHarness,
  testModel,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt reasoning/session creation guard", () => {
  const tempPaths: string[] = [];
  const sessionKey = "agent:main:discord:channel:reasoning-guard";

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
    hoisted.createAgentSessionMock.mockImplementation(async () => ({
      session: createDefaultEmbeddedSession(),
    }));
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("passes non-off thinking through to createAgentSession when the model supports reasoning", async () => {
    await createContextEngineAttemptRunner({
      sessionKey,
      tempPaths,
      contextEngine: {
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
      },
      attemptOverrides: {
        thinkLevel: "minimal",
        model: {
          ...testModel,
          reasoning: true,
        },
      },
    });

    expect(hoisted.createAgentSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ reasoning: true }),
        thinkingLevel: "minimal",
      }),
    );
  });

  it("fails fast instead of letting the SDK silently clamp a non-off thinking level to off", async () => {
    await expect(
      createContextEngineAttemptRunner({
        sessionKey,
        tempPaths,
        contextEngine: {
          assemble: async ({ messages }) => ({ messages, estimatedTokens: 1 }),
        },
        attemptOverrides: {
          thinkLevel: "minimal",
          model: {
            ...testModel,
            reasoning: false,
          },
        },
      }),
    ).rejects.toThrow(
      'Embedded run resolved thinking level "minimal" for non-reasoning model openai/gpt-test; refusing to create session because pi-coding-agent would clamp it to "off".',
    );

    expect(hoisted.createAgentSessionMock).not.toHaveBeenCalled();
  });
});
