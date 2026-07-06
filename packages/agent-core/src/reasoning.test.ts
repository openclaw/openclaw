import { describe, expect, it } from "vitest";
import type { Model } from "../../llm-core/src/index.js";
import { Agent } from "./agent.js";
import { resolveAgentReasoningOption } from "./reasoning.js";
import type { StreamFn } from "./types.js";

function makeModel(
  thinkingLevelMap?: Model["thinkingLevelMap"],
  overrides: Partial<Model> = {},
): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    thinkingLevelMap,
    ...overrides,
  };
}

describe("resolveAgentReasoningOption", () => {
  it("uses a model's enabled fallback for explicit off", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: "low" }), "off")).toBe("low");
  });

  it.each([undefined, null, "none"])("disables reasoning when off maps to %s", (offFallback) => {
    expect(resolveAgentReasoningOption(makeModel({ off: offFallback }), "off")).toBeUndefined();
  });

  it("preserves enabled thinking levels", () => {
    expect(resolveAgentReasoningOption(makeModel({ off: "low" }), "high")).toBe("high");
  });

  it.each(["anthropic-messages", "bedrock-converse-stream"] as const)(
    "maps explicit off to low for mandatory Claude aliases on %s",
    (api) => {
      expect(
        resolveAgentReasoningOption(
          makeModel(undefined, {
            id: "production-deployment",
            api,
            params: { canonicalModelId: "claude-fable-5" },
          }),
          "off",
        ),
      ).toBe("low");
      expect(
        resolveAgentReasoningOption(
          makeModel(undefined, {
            id: "production-deployment",
            api,
            params: { canonicalModelId: "claude-mythos-preview" },
          }),
          "off",
        ),
      ).toBe("low");
    },
  );

  it("preserves explicit off for Claude Sonnet 5", () => {
    expect(
      resolveAgentReasoningOption(
        makeModel(undefined, {
          id: "production-deployment",
          params: { canonicalModelId: "claude-sonnet-5" },
        }),
        "off",
      ),
    ).toBe("off");
  });

  it("uses Claude Sonnet 5 provider-default reasoning when off is only the agent default", () => {
    expect(
      resolveAgentReasoningOption(
        makeModel(undefined, {
          id: "production-deployment",
          params: { canonicalModelId: "claude-sonnet-5" },
        }),
        "off",
        "default",
      ),
    ).toBeUndefined();
  });

  it("distinguishes Agent's default thinking level from a later explicit off choice", async () => {
    const model = makeModel(undefined, { id: "claude-sonnet-5" });
    const observedReasoning: Array<string | undefined> = [];
    const streamFn: StreamFn = async (_model, _context, options) => {
      observedReasoning.push(options?.reasoning);
      throw new Error("stop after capturing request options");
    };
    const agent = new Agent({
      initialState: { model, thinkingLevel: "off" },
      initialThinkingLevelSource: "default",
      streamFn,
    });

    await agent.prompt("default");
    agent.state.thinkingLevel = "off";
    await agent.prompt("explicit");

    expect(observedReasoning).toEqual([undefined, "off"]);
  });
});
