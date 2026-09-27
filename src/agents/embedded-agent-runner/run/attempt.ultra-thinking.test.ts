// Coverage for keeping Ultra logical until the embedded runtime/provider boundary.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeAll(async () => {
  await preloadRunEmbeddedAttemptForTests();
});

beforeEach(() => {
  resetEmbeddedAttemptHarness();
});

afterEach(async () => {
  await cleanupTempPaths(tempPaths);
  vi.restoreAllMocks();
});

describe("runEmbeddedAttempt Ultra thinking", () => {
  it.each([
    { name: "reasoning", provider: "custom", reasoning: true, expected: "high" },
    { name: "nonreasoning", provider: "custom", reasoning: false, expected: "off" },
    {
      name: "no effort control",
      provider: "openai",
      reasoning: true,
      compat: { supportsReasoningEffort: false },
      expected: undefined,
    },
  ])(
    "keeps Ultra orchestration with a $name provider",
    async ({ provider, reasoning, compat, expected }) => {
      await createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:main",
        tempPaths,
        attemptOverrides: {
          disableTools: false,
          thinkLevel: "ultra",
          model: {
            id: "synthetic-model",
            provider,
            name: "Synthetic model",
            api: "openai-completions",
            baseUrl: "https://example.invalid/v1",
            reasoning,
            compat,
            input: ["text"],
            contextWindow: 8192,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        },
      });

      const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
        proactiveSubagentOrchestration?: boolean;
      };
      const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
        thinkingLevel?: string;
      };
      const providerThinkingLevel = hoisted.applyExtraParamsToAgentMock.mock.calls.at(-1)?.[5];

      expect(promptInput.proactiveSubagentOrchestration).toBe(true);
      expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ requesterThinkingLevel: "ultra" }),
        undefined,
      );
      expect(sessionOptions.thinkingLevel).toBe(expected ?? "off");
      expect(providerThinkingLevel).toBe(expected);
    },
  );

  it("keeps explicit max at max without enabling proactive prompting", async () => {
    await createContextEngineAttemptRunner({
      contextEngine: createContextEngineBootstrapAndAssemble(),
      sessionKey: "agent:main:main",
      tempPaths,
      attemptOverrides: {
        disableTools: false,
        thinkLevel: "max",
      },
    });

    const promptInput = hoisted.embeddedSystemPromptInputs.at(-1) as {
      proactiveSubagentOrchestration?: boolean;
    };
    const sessionOptions = hoisted.createAgentSessionMock.mock.calls.at(-1)?.[0] as {
      thinkingLevel?: string;
    };
    const providerThinkingLevel = hoisted.applyExtraParamsToAgentMock.mock.calls.at(-1)?.[5];

    expect(promptInput.proactiveSubagentOrchestration).toBe(false);
    expect(hoisted.createOpenClawCodingToolsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ requesterThinkingLevel: "max" }),
      undefined,
    );
    expect(sessionOptions.thinkingLevel).toBe("max");
    expect(providerThinkingLevel).toBe("max");
  });
});
