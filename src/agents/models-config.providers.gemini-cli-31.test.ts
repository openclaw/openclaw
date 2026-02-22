import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, SimpleStreamOptions } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { buildGeminiCliExtraModelsProvider } from "./models-config.providers.js";
import {
  applyExtraParamsToAgent,
  geminiCliBudgetToThinkingLevel,
  isGeminiCli31Model,
} from "./pi-embedded-runner/extra-params.js";

// Mock @mariozechner/pi-ai.  streamSimple is needed by extra-params wrappers;
// getOAuthProviders is called at module-load time by auth-profiles/oauth.ts
// (transitive dependency of models-config.providers).
vi.mock("@mariozechner/pi-ai", () => ({
  streamSimple: vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(),
  })),
  getOAuthProviders: vi.fn(() => []),
}));

// ---------------------------------------------------------------------------
// buildGeminiCli31Model / buildGeminiCliExtraModelsProvider
// ---------------------------------------------------------------------------

describe("buildGeminiCliExtraModelsProvider", () => {
  it("returns a provider with google-gemini-cli API", () => {
    const provider = buildGeminiCliExtraModelsProvider();
    expect(provider.api).toBe("google-gemini-cli");
    expect(provider.auth).toBe("oauth");
    expect(provider.baseUrl).toBe("https://cloudcode-pa.googleapis.com");
  });

  it("includes gemini-3.1-pro-preview model", () => {
    const provider = buildGeminiCliExtraModelsProvider();
    expect(provider.models).toHaveLength(1);

    const model = provider.models[0];
    expect(model.id).toBe("gemini-3.1-pro-preview");
    expect(model.name).toBe("Gemini 3.1 Pro");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(65536);
  });

  it("reports zero cost for all categories", () => {
    const model = buildGeminiCliExtraModelsProvider().models[0];
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

// ---------------------------------------------------------------------------
// isGeminiCli31Model
// ---------------------------------------------------------------------------

describe("isGeminiCli31Model", () => {
  it("matches gemini-3.1-pro-preview", () => {
    expect(isGeminiCli31Model("gemini-3.1-pro-preview")).toBe(true);
  });

  it("matches gemini-3.1-flash-preview", () => {
    expect(isGeminiCli31Model("gemini-3.1-flash-preview")).toBe(true);
  });

  it("does not match gemini-3-pro-preview (Gemini 3.0)", () => {
    expect(isGeminiCli31Model("gemini-3-pro-preview")).toBe(false);
  });

  it("does not match gemini-2.5-pro", () => {
    expect(isGeminiCli31Model("gemini-2.5-pro")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// geminiCliBudgetToThinkingLevel
// ---------------------------------------------------------------------------

describe("geminiCliBudgetToThinkingLevel", () => {
  it("maps low budgets (<=2048) to LOW", () => {
    expect(geminiCliBudgetToThinkingLevel(1024)).toBe("LOW");
    expect(geminiCliBudgetToThinkingLevel(2048)).toBe("LOW");
  });

  it("maps higher budgets (>2048) to HIGH", () => {
    expect(geminiCliBudgetToThinkingLevel(8192)).toBe("HIGH");
    expect(geminiCliBudgetToThinkingLevel(16384)).toBe("HIGH");
  });
});

// ---------------------------------------------------------------------------
// Gemini 3.1 thinking-level wrapper (via applyExtraParamsToAgent)
// ---------------------------------------------------------------------------

type GeminiPayload = {
  model?: string;
  request?: {
    generationConfig?: {
      thinkingConfig?: {
        includeThoughts?: boolean;
        thinkingBudget?: number;
        thinkingLevel?: string;
      };
    };
  };
};

/**
 * Helper: apply the wrapper and simulate a stream call, returning the
 * (possibly mutated) payload so we can assert on thinkingConfig.
 */
function runGeminiThinkingCase(params: {
  provider: string;
  modelId: string;
  payload: GeminiPayload;
  options?: SimpleStreamOptions;
}): GeminiPayload {
  const payload = structuredClone(params.payload);
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload);
    return {} as ReturnType<StreamFn>;
  };
  const agent = { streamFn: baseStreamFn };

  applyExtraParamsToAgent(agent, undefined, params.provider, params.modelId);

  const model = {
    id: params.modelId,
    api: "google-gemini-cli" as const,
  } as Parameters<StreamFn>[0];
  const context: Context = { messages: [] };
  void agent.streamFn?.(model, context, params.options ?? {});

  return payload;
}

describe("extra-params: Gemini 3.1 thinking-level fix", () => {
  it("replaces thinkingBudget with thinkingLevel for gemini-3.1-pro-preview", () => {
    const result = runGeminiThinkingCase({
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro-preview",
      payload: {
        model: "gemini-3.1-pro-preview",
        request: {
          generationConfig: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 8192,
            },
          },
        },
      },
    });

    const tc = result.request?.generationConfig?.thinkingConfig;
    expect(tc).toBeDefined();
    expect(tc?.thinkingLevel).toBe("HIGH");
    expect(tc?.thinkingBudget).toBeUndefined();
    expect(tc?.includeThoughts).toBe(true);
  });

  it("maps low budget to LOW level for 3.1 models", () => {
    const result = runGeminiThinkingCase({
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro-preview",
      payload: {
        model: "gemini-3.1-pro-preview",
        request: {
          generationConfig: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 1024,
            },
          },
        },
      },
    });

    expect(result.request?.generationConfig?.thinkingConfig?.thinkingLevel).toBe("LOW");
    expect(result.request?.generationConfig?.thinkingConfig?.thinkingBudget).toBeUndefined();
  });

  it("does not modify payload for gemini-3-pro-preview (Gemini 3.0)", () => {
    const result = runGeminiThinkingCase({
      provider: "google-gemini-cli",
      modelId: "gemini-3-pro-preview",
      payload: {
        model: "gemini-3-pro-preview",
        request: {
          generationConfig: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 8192,
            },
          },
        },
      },
    });

    const tc = result.request?.generationConfig?.thinkingConfig;
    expect(tc?.thinkingBudget).toBe(8192);
    expect(tc?.thinkingLevel).toBeUndefined();
  });

  it("does not modify payload for non-gemini-cli providers", () => {
    const result = runGeminiThinkingCase({
      provider: "openai",
      modelId: "gemini-3.1-pro-preview",
      payload: {
        model: "gemini-3.1-pro-preview",
        request: {
          generationConfig: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: 8192,
            },
          },
        },
      },
    });

    const tc = result.request?.generationConfig?.thinkingConfig;
    expect(tc?.thinkingBudget).toBe(8192);
    expect(tc?.thinkingLevel).toBeUndefined();
  });

  it("leaves payload untouched when thinkingConfig has no thinkingBudget", () => {
    const result = runGeminiThinkingCase({
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro-preview",
      payload: {
        model: "gemini-3.1-pro-preview",
        request: {
          generationConfig: {
            thinkingConfig: {
              includeThoughts: true,
              thinkingLevel: "HIGH",
            },
          },
        },
      },
    });

    const tc = result.request?.generationConfig?.thinkingConfig;
    expect(tc?.thinkingLevel).toBe("HIGH");
    expect(tc?.thinkingBudget).toBeUndefined();
  });
});
