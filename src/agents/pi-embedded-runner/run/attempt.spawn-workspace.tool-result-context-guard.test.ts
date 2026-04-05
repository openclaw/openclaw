import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
  testModel,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt tool-result context guard budget", () => {
  const sessionKey = "agent:main:test-tool-result-guard-budget";
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("uses resolved context-window tokens instead of maxTokens fallback", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: {
        assemble: async ({ messages }) => ({
          messages,
          estimatedTokens: 1,
        }),
      },
      sessionKey,
      tempPaths,
      attemptOverrides: {
        config: {
          models: {
            providers: {
              openai: {
                baseUrl: "https://example.invalid",
                models: [
                  {
                    id: "gpt-test",
                    name: "gpt-test",
                    reasoning: false,
                    input: ["text"],
                    cost: {
                      input: 0,
                      output: 0,
                      cacheRead: 0,
                      cacheWrite: 0,
                    },
                    contextWindow: 200_000,
                    maxTokens: 64,
                  },
                ],
              },
            },
          },
        },
        resolvedApiKey: "test-key",
        model: {
          ...(testModel as unknown as Record<string, unknown>),
          contextWindow: undefined,
          contextTokens: undefined,
          maxTokens: 64,
        } as unknown as Model<Api>,
      },
    });

    expect(hoisted.installToolResultContextGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contextWindowTokens: 200_000,
      }),
    );
  });
});
