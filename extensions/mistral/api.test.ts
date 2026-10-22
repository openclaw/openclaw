import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  applyMistralModelCompat,
  MISTRAL_MEDIUM_3_5_ID,
  MISTRAL_SMALL_4_ID,
  MISTRAL_SMALL_LATEST_ID,
} from "./api.js";
import mistralPlugin from "./index.js";

const transportCompat = {
  supportsStore: false,
  supportsPromptCacheKey: true,
  supportsLongCacheRetention: false,
  maxTokensField: "max_tokens",
} as const;

describe("applyMistralModelCompat", () => {
  it("applies the Mistral request-shape compat flags", () => {
    expect(applyMistralModelCompat({})).toEqual({
      compat: { ...transportCompat, supportsReasoningEffort: false },
    });
  });

  it.each([MISTRAL_SMALL_LATEST_ID, MISTRAL_SMALL_4_ID, MISTRAL_MEDIUM_3_5_ID])(
    "applies reasoning compat and overrides unsafe flags for %s",
    (id) => {
      const normalized = applyMistralModelCompat({
        id,
        compat: {
          supportsStore: true,
          supportsReasoningEffort: false,
          maxTokensField: "max_completion_tokens" as const,
        },
      });
      expect(normalized.compat).toEqual({
        ...transportCompat,
        supportsReasoningEffort: true,
        reasoningEffortMap: {
          off: "none",
          minimal: "none",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "high",
          adaptive: "high",
          max: "high",
        },
      });
    },
  );

  it("overrides explicit compat values that would trigger 422s", () => {
    const normalized = applyMistralModelCompat({
      id: "mistral-large-latest",
      compat: {
        supportsStore: true,
        supportsReasoningEffort: true,
        maxTokensField: "max_completion_tokens" as const,
      },
    });
    expect(normalized.compat).toEqual({ ...transportCompat, supportsReasoningEffort: false });
  });

  it("returns the same object when the compat patch is already present", () => {
    const model = { compat: { ...transportCompat, supportsReasoningEffort: false } };
    expect(applyMistralModelCompat(model)).toBe(model);
  });

  it("exposes every documented thinking level through the registered provider", async () => {
    const provider = await registerSingleProviderPlugin(mistralPlugin);
    const profile = provider.resolveThinkingProfile?.({
      provider: "mistral",
      modelId: MISTRAL_SMALL_LATEST_ID,
    });
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
  });
});
