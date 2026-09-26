// Mistral tests cover api plugin behavior.
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  applyMistralModelCompat,
  MISTRAL_MEDIUM_3_5_ID,
  MISTRAL_SMALL_4_ID,
  MISTRAL_SMALL_LATEST_ID,
  resolveMistralCompatPatch,
} from "./api.js";
import mistralPlugin from "./index.js";

type MistralCompatShape = {
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  reasoningEffortMap?: Record<string, string>;
  supportsLongCacheRetention?: boolean;
  supportsPromptCacheKey?: boolean;
  supportsReasoningEffort?: boolean;
  supportsStore?: boolean;
};

function readCompat(model: unknown): MistralCompatShape | undefined {
  return (model as { compat?: MistralCompatShape }).compat;
}

const MISTRAL_REASONING_EFFORT_MAP = {
  off: "none",
  minimal: "none",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
  adaptive: "high",
  max: "high",
};

describe("resolveMistralCompatPatch", () => {
  it.each([MISTRAL_SMALL_LATEST_ID, MISTRAL_SMALL_4_ID, MISTRAL_MEDIUM_3_5_ID])(
    "enables reasoning_effort mapping for %s",
    (id) => {
      expect(resolveMistralCompatPatch({ id })).toEqual({
        supportsStore: false,
        supportsPromptCacheKey: true,
        supportsLongCacheRetention: false,
        supportsReasoningEffort: true,
        maxTokensField: "max_tokens",
        reasoningEffortMap: MISTRAL_REASONING_EFFORT_MAP,
      });
    },
  );

  it("disables reasoning_effort for other Mistral model ids", () => {
    expect(resolveMistralCompatPatch({ id: "mistral-large-latest" })).toEqual({
      supportsStore: false,
      supportsPromptCacheKey: true,
      supportsLongCacheRetention: false,
      maxTokensField: "max_tokens",
      supportsReasoningEffort: false,
    });
  });
});

describe("applyMistralModelCompat", () => {
  it("applies the Mistral request-shape compat flags", () => {
    const normalized = applyMistralModelCompat({});
    expect(readCompat(normalized)?.supportsStore).toBe(false);
    expect(readCompat(normalized)?.supportsPromptCacheKey).toBe(true);
    expect(readCompat(normalized)?.supportsLongCacheRetention).toBe(false);
    expect(readCompat(normalized)?.supportsReasoningEffort).toBe(false);
    expect(readCompat(normalized)?.maxTokensField).toBe("max_tokens");
    expect(readCompat(normalized)?.reasoningEffortMap).toBeUndefined();
  });

  it.each([MISTRAL_SMALL_LATEST_ID, MISTRAL_SMALL_4_ID, MISTRAL_MEDIUM_3_5_ID])(
    "applies reasoning compat for %s",
    (id) => {
      const normalized = applyMistralModelCompat({ id });
      expect(readCompat(normalized)?.supportsReasoningEffort).toBe(true);
      expect(readCompat(normalized)?.reasoningEffortMap?.high).toBe("high");
      expect(readCompat(normalized)?.reasoningEffortMap?.off).toBe("none");
    },
  );

  it("overrides explicit compat values that would trigger 422s", () => {
    const normalized = applyMistralModelCompat({
      compat: {
        supportsStore: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_completion_tokens" as const,
      },
    });
    expect(readCompat(normalized)?.supportsStore).toBe(false);
    expect(readCompat(normalized)?.supportsReasoningEffort).toBe(false);
    expect(readCompat(normalized)?.maxTokensField).toBe("max_tokens");
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
    expect(readCompat(normalized)?.supportsStore).toBe(false);
    expect(readCompat(normalized)?.supportsReasoningEffort).toBe(true);
    expect(readCompat(normalized)?.maxTokensField).toBe("max_tokens");
  });

  it("returns the same object when the compat patch is already present", () => {
    const model = {
      compat: {
        supportsStore: false,
        supportsPromptCacheKey: true,
        supportsLongCacheRetention: false,
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

  it("returns the same object when mistral-medium-3-5 compat is fully normalized", () => {
    const model = {
      id: MISTRAL_MEDIUM_3_5_ID,
      compat: resolveMistralCompatPatch({ id: MISTRAL_MEDIUM_3_5_ID }),
    };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it.each([MISTRAL_SMALL_LATEST_ID, MISTRAL_SMALL_4_ID, MISTRAL_MEDIUM_3_5_ID])(
    "exposes every documented thinking level for %s",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(mistralPlugin);
      const profile = provider.resolveThinkingProfile?.({ provider: "mistral", modelId });

      expect(profile?.levels.map(({ id }) => id)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "adaptive",
        "max",
      ]);
      expect(profile?.defaultLevel).toBe("off");
    },
  );
});
