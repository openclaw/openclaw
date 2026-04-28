import { describe, expect, it } from "vitest";
import type { CopilotApiModel } from "./models-api.js";
import {
  deduplicateModels,
  isReasoningModel,
  isUserFacingModel,
  mapCopilotApiModel,
  mapCopilotModels,
  resolveInputModalities,
  resolveTransportApiFromEndpoints,
} from "./models-mapping.js";

function makeApiModel(overrides: Partial<CopilotApiModel> = {}): CopilotApiModel {
  return {
    id: "test-model",
    name: "Test Model",
    version: "test-model",
    vendor: "Test",
    ...overrides,
  };
}

describe("resolveTransportApiFromEndpoints", () => {
  it("returns anthropic-messages for /v1/messages endpoint", () => {
    expect(resolveTransportApiFromEndpoints("claude-sonnet-4.6", ["/v1/messages", "/chat/completions"]))
      .toBe("anthropic-messages");
  });

  it("returns openai-responses for /responses endpoint", () => {
    expect(resolveTransportApiFromEndpoints("gpt-5.4", ["/responses", "/chat/completions"]))
      .toBe("openai-responses");
  });

  it("returns openai-completions for only /chat/completions", () => {
    expect(resolveTransportApiFromEndpoints("gemini-3-flash", ["/chat/completions"]))
      .toBe("openai-completions");
  });

  it("falls back to heuristic for claude models without endpoints", () => {
    expect(resolveTransportApiFromEndpoints("claude-opus-4.7", []))
      .toBe("anthropic-messages");
  });

  it("falls back to openai-responses for non-claude models without endpoints", () => {
    expect(resolveTransportApiFromEndpoints("gpt-4o", []))
      .toBe("openai-responses");
  });

  it("prefers /v1/messages over /responses when both present", () => {
    expect(resolveTransportApiFromEndpoints("claude-sonnet-4.6", ["/v1/messages", "/responses"]))
      .toBe("anthropic-messages");
  });
});

describe("isReasoningModel", () => {
  it("identifies codex models as reasoning", () => {
    expect(isReasoningModel(makeApiModel({ id: "gpt-5.2-codex" }))).toBe(true);
    expect(isReasoningModel(makeApiModel({ id: "gpt-5.3-codex" }))).toBe(true);
  });

  it("identifies o-series models as reasoning", () => {
    expect(isReasoningModel(makeApiModel({ id: "o1" }))).toBe(true);
    expect(isReasoningModel(makeApiModel({ id: "o3-mini" }))).toBe(true);
  });

  it("identifies models with xhigh reasoning_effort as reasoning", () => {
    expect(isReasoningModel(makeApiModel({
      id: "gpt-5.4",
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] } },
    }))).toBe(true);
  });

  it("does not flag claude as reasoning", () => {
    expect(isReasoningModel(makeApiModel({
      id: "claude-opus-4.6",
      capabilities: { supports: { reasoning_effort: ["low", "medium", "high"] } },
    }))).toBe(false);
  });

  it("does not flag standard gpt as reasoning", () => {
    expect(isReasoningModel(makeApiModel({ id: "gpt-4o" }))).toBe(false);
  });
});

describe("resolveInputModalities", () => {
  it("includes image for vision models", () => {
    expect(resolveInputModalities(makeApiModel({
      capabilities: { supports: { vision: true } },
    }))).toEqual(["text", "image"]);
  });

  it("includes image when vision limits exist", () => {
    expect(resolveInputModalities(makeApiModel({
      capabilities: { limits: { vision: { max_prompt_images: 5 } } },
    }))).toEqual(["text", "image"]);
  });

  it("returns text only for non-vision models", () => {
    expect(resolveInputModalities(makeApiModel({
      capabilities: { supports: { vision: false } },
    }))).toEqual(["text"]);
  });
});

describe("isUserFacingModel", () => {
  it("filters out router models", () => {
    expect(isUserFacingModel(makeApiModel({ id: "accounts/msft/routers/abc123" }))).toBe(false);
  });

  it("filters out embedding models by capability type", () => {
    expect(isUserFacingModel(makeApiModel({
      id: "text-embedding-3-small",
      capabilities: { type: "embeddings" } as CopilotApiModel["capabilities"],
    }))).toBe(false);
  });

  it("keeps regular chat models", () => {
    expect(isUserFacingModel(makeApiModel({ id: "claude-opus-4.6" }))).toBe(true);
  });
});

describe("deduplicateModels", () => {
  it("keeps the entry with more capabilities", () => {
    const models = [
      makeApiModel({ id: "gpt-4o", capabilities: { supports: { streaming: true } } }),
      makeApiModel({ id: "gpt-4o", capabilities: { supports: { streaming: true, vision: true, tool_calls: true } } }),
    ];
    const result = deduplicateModels(models);
    expect(result).toHaveLength(1);
    expect(result[0].capabilities?.supports?.vision).toBe(true);
  });

  it("preserves unique models", () => {
    const models = [
      makeApiModel({ id: "claude-opus-4.6" }),
      makeApiModel({ id: "gpt-4o" }),
    ];
    expect(deduplicateModels(models)).toHaveLength(2);
  });
});

describe("mapCopilotApiModel", () => {
  it("maps context window and max tokens from API", () => {
    const result = mapCopilotApiModel(makeApiModel({
      id: "claude-opus-4.6-1m",
      capabilities: {
        limits: {
          max_context_window_tokens: 1_000_000,
          max_output_tokens: 64_000,
        },
      },
    }));
    expect(result.contextWindow).toBe(1_000_000);
    expect(result.maxTokens).toBe(64_000);
  });

  it("uses defaults when API has no limits", () => {
    const result = mapCopilotApiModel(makeApiModel({ id: "test" }));
    expect(result.contextWindow).toBe(128_000);
    expect(result.maxTokens).toBe(8_192);
  });

  it("preserves copilot capabilities metadata", () => {
    const result = mapCopilotApiModel(makeApiModel({
      id: "claude-opus-4.6",
      capabilities: {
        supports: {
          adaptive_thinking: true,
          max_thinking_budget: 32000,
          min_thinking_budget: 1024,
          reasoning_effort: ["low", "medium", "high"],
          tool_calls: true,
          streaming: true,
        },
      },
    }));
    expect(result._copilotCapabilities?.adaptiveThinking).toBe(true);
    expect(result._copilotCapabilities?.maxThinkingBudget).toBe(32000);
    expect(result._copilotCapabilities?.reasoningEffort).toEqual(["low", "medium", "high"]);
  });

  it("sets zero cost for all models", () => {
    const result = mapCopilotApiModel(makeApiModel({ id: "test" }));
    expect(result.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("sets supportedReasoningEfforts in compat from API", () => {
    const result = mapCopilotApiModel(makeApiModel({
      id: "gpt-5.4",
      capabilities: {
        supports: { reasoning_effort: ["low", "medium", "high", "xhigh"] },
      },
    }));
    expect(result.compat?.supportedReasoningEfforts).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("omits compat when model has no special flags", () => {
    const result = mapCopilotApiModel(makeApiModel({
      id: "test",
      capabilities: { supports: { tool_calls: true, streaming: true } },
    }));
    expect(result.compat).toBeUndefined();
  });
});

describe("mapCopilotModels", () => {
  it("filters out embedding and router models", () => {
    const models = [
      makeApiModel({ id: "claude-opus-4.6", capabilities: { supports: { vision: true } } }),
      makeApiModel({ id: "text-embedding-3-small", type: "embeddings" }),
      makeApiModel({ id: "accounts/msft/routers/abc", vendor: "Fireworks" }),
    ];
    const result = mapCopilotModels(models);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("claude-opus-4.6");
  });
});
