import { describe, expect, it } from "vitest";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../src/config/model-input.js";
import {
  createConfigWithFallbacks,
  createLegacyProviderConfig,
  EXPECTED_FALLBACKS,
} from "../../test/helpers/extensions/onboard-config.js";
import { buildMistralModelDefinition as buildBundledMistralModelDefinition } from "./model-definitions.js";
import {
  applyMistralConfig,
  applyMistralProviderConfig,
  MISTRAL_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("mistral onboard", () => {
  it("adds Mistral provider with correct settings", () => {
    const cfg = applyMistralConfig({});
    expect(cfg.models?.providers?.mistral).toMatchObject({
      baseUrl: "https://api.mistral.ai/v1",
      api: "openai-completions",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      MISTRAL_DEFAULT_MODEL_REF,
    );
  });

  it("merges Mistral models and keeps existing provider overrides", () => {
    const cfg = applyMistralProviderConfig(
      createLegacyProviderConfig({
        providerId: "mistral",
        api: "anthropic-messages",
        modelId: "custom-model",
        modelName: "Custom",
      }),
    );

    expect(cfg.models?.providers?.mistral?.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(cfg.models?.providers?.mistral?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.mistral?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.mistral?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mistral-large-latest",
    ]);
    const mistralDefault = cfg.models?.providers?.mistral?.models.find(
      (model) => model.id === "mistral-large-latest",
    );
    expect(mistralDefault?.contextWindow).toBe(262144);
    expect(mistralDefault?.maxTokens).toBe(16384);
  });

  it("uses the bundled mistral default model definition", () => {
    const bundled = buildBundledMistralModelDefinition();
    const cfg = applyMistralProviderConfig({});
    const defaultModel = cfg.models?.providers?.mistral?.models.find((model) => model.id === bundled.id);

    expect(defaultModel).toMatchObject({
      id: bundled.id,
      contextWindow: bundled.contextWindow,
      maxTokens: bundled.maxTokens,
    });
  });

  it("adds the expected alias for the default model", () => {
    const cfg = applyMistralProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[MISTRAL_DEFAULT_MODEL_REF]?.alias).toBe("Mistral");
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyMistralConfig(createConfigWithFallbacks());
    expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
      ...EXPECTED_FALLBACKS,
    ]);
  });
});
