import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  applyMistralModelCompat,
  MISTRAL_MODEL_TRANSPORT_PATCH,
  MISTRAL_SMALL_LATEST_ID,
  resolveMistralCompatPatch,
} from "./api.js";
import mistralPlugin from "./index.js";
import { contributeMistralResolvedModelCompat } from "./provider-compat.js";

function readCompat<T>(model: unknown): T | undefined {
  return (model as { compat?: T }).compat;
}

function supportsStore(model: unknown): boolean | undefined {
  return readCompat<{ supportsStore?: boolean }>(model)?.supportsStore;
}

function supportsReasoningEffort(model: unknown): boolean | undefined {
  return readCompat<{ supportsReasoningEffort?: boolean }>(model)?.supportsReasoningEffort;
}

function maxTokensField(model: unknown): "max_completion_tokens" | "max_tokens" | undefined {
  return readCompat<{ maxTokensField?: "max_completion_tokens" | "max_tokens" }>(model)
    ?.maxTokensField;
}

function reasoningEffortMap(model: unknown): Record<string, string> | undefined {
  return readCompat<{ reasoningEffortMap?: Record<string, string> }>(model)?.reasoningEffortMap;
}

describe("resolveMistralCompatPatch", () => {
  it("enables reasoning_effort mapping for mistral-small-latest", () => {
    expect(resolveMistralCompatPatch({ id: MISTRAL_SMALL_LATEST_ID })).toMatchObject({
      supportsStore: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      reasoningEffortMap: expect.objectContaining({ high: "high", off: "none" }),
    });
  });

  it("disables reasoning_effort for other Mistral model ids", () => {
    expect(resolveMistralCompatPatch({ id: "mistral-large-latest" })).toEqual({
      ...MISTRAL_MODEL_TRANSPORT_PATCH,
      supportsReasoningEffort: false,
    });
  });
});

describe("applyMistralModelCompat", () => {
  it("applies the Mistral request-shape compat flags", () => {
    const normalized = applyMistralModelCompat({});
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(false);
    expect(maxTokensField(normalized)).toBe("max_tokens");
    expect(reasoningEffortMap(normalized)).toBeUndefined();
  });

  it("applies reasoning compat for mistral-small-latest", () => {
    const normalized = applyMistralModelCompat({ id: MISTRAL_SMALL_LATEST_ID });
    expect(supportsReasoningEffort(normalized)).toBe(true);
    expect(reasoningEffortMap(normalized)?.high).toBe("high");
    expect(reasoningEffortMap(normalized)?.off).toBe("none");
  });

  it("overrides explicit compat values that would trigger 422s", () => {
    const normalized = applyMistralModelCompat({
      compat: {
        supportsStore: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_completion_tokens" as const,
      },
    });
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(false);
    expect(maxTokensField(normalized)).toBe("max_tokens");
  });

  it("overrides explicit compat on mistral-small-latest except reasoning enablement", () => {
    const normalized = applyMistralModelCompat({
      id: MISTRAL_SMALL_LATEST_ID,
      compat: {
        supportsStore: true,
        supportsReasoningEffort: false,
        maxTokensField: "max_completion_tokens" as const,
      },
    });
    expect(supportsStore(normalized)).toBe(false);
    expect(supportsReasoningEffort(normalized)).toBe(true);
    expect(maxTokensField(normalized)).toBe("max_tokens");
  });

  it("returns the same object when the compat patch is already present", () => {
    const model = {
      compat: {
        supportsStore: false,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens" as const,
      },
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("returns the same object when mistral-small-latest compat is fully normalized", () => {
    const model = {
      id: MISTRAL_SMALL_LATEST_ID,
      compat: resolveMistralCompatPatch({ id: MISTRAL_SMALL_LATEST_ID }),
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("contributes Mistral transport compat for native, provider-family, and hinted custom routes", () => {
    expect(
      contributeMistralResolvedModelCompat({
        modelId: "mistral-large-latest",
        model: {
          provider: "mistral",
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
        },
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);

    expect(
      contributeMistralResolvedModelCompat({
        modelId: "custom-model",
        model: {
          provider: "custom-mistral-host",
          api: "openai-completions",
          baseUrl: "https://api.mistral.ai/v1",
        },
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);

    expect(
      contributeMistralResolvedModelCompat({
        modelId: "mistralai/mistral-small-3.2",
        model: {
          provider: "openrouter",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);
  });
});

describe("mistral plugin register", () => {
  it("registers the speech provider and wires contributeResolvedModelCompat through to native, provider-family, and hinted custom routes", () => {
    type ContributeResolvedModelCompat = (params: {
      modelId: string;
      model: Record<string, unknown>;
    }) => unknown;

    let capturedContributeResolvedModelCompat: ContributeResolvedModelCompat | undefined;
    const registerSpeechProvider = vi.fn();
    const registerMediaUnderstandingProvider = vi.fn();

    const fakeApi = {
      registerProvider: (provider: {
        contributeResolvedModelCompat?: ContributeResolvedModelCompat;
      }) => {
        capturedContributeResolvedModelCompat = provider.contributeResolvedModelCompat;
      },
      registerSpeechProvider,
      registerMediaUnderstandingProvider,
    };

    mistralPlugin.register(fakeApi as unknown as OpenClawPluginApi);

    expect(registerSpeechProvider).toHaveBeenCalledOnce();
    expect(registerMediaUnderstandingProvider).toHaveBeenCalledOnce();
    expect(capturedContributeResolvedModelCompat).toBeDefined();

    // native Mistral provider route
    expect(
      capturedContributeResolvedModelCompat!({
        modelId: "mistral-large-latest",
        model: {
          provider: "mistral",
          api: "openai-completions",
          baseUrl: "https://proxy.example/v1",
        },
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);

    // hinted custom route via api.mistral.ai base URL
    expect(
      capturedContributeResolvedModelCompat!({
        modelId: "custom-model",
        model: {
          provider: "custom-mistral-host",
          api: "openai-completions",
          baseUrl: "https://api.mistral.ai/v1",
        },
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);

    // provider-family route via OpenRouter Mistral model id hint
    expect(
      capturedContributeResolvedModelCompat!({
        modelId: "mistralai/mistral-small-3.2",
        model: {
          provider: "openrouter",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
        },
      }),
    ).toEqual(MISTRAL_MODEL_TRANSPORT_PATCH);
  });
});
