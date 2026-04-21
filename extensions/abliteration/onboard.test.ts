import { describe, expect, it } from "vitest";
import {
  expectProviderOnboardMergedLegacyConfig,
  expectProviderOnboardPrimaryModel,
} from "../../test/helpers/plugins/provider-onboard.js";
import { ABLITERATION_DEFAULT_MODEL_REF as ABLITERATION_DEFAULT_MODEL_REF_PUBLIC } from "./api.js";
import {
  ABLITERATION_DEFAULT_MODEL_REF,
  applyAbliterationConfig,
  applyAbliterationProviderConfig,
} from "./onboard.js";

describe("abliteration onboard", () => {
  it("adds Abliteration provider with correct settings", () => {
    const cfg = applyAbliterationConfig({});
    expect(cfg.models?.providers?.abliteration).toMatchObject({
      baseUrl: "https://api.abliteration.ai/v1",
      api: "openai-responses",
      authHeader: true,
    });
    expectProviderOnboardPrimaryModel({
      applyConfig: applyAbliterationConfig,
      modelRef: ABLITERATION_DEFAULT_MODEL_REF_PUBLIC,
    });
  });

  it("keeps the public default model ref aligned", () => {
    expect(ABLITERATION_DEFAULT_MODEL_REF).toBe(ABLITERATION_DEFAULT_MODEL_REF_PUBLIC);
    expectProviderOnboardPrimaryModel({
      applyConfig: applyAbliterationConfig,
      modelRef: ABLITERATION_DEFAULT_MODEL_REF,
    });
  });

  it("merges existing Abliteration provider models", () => {
    const provider = expectProviderOnboardMergedLegacyConfig({
      applyProviderConfig: applyAbliterationProviderConfig,
      providerId: "abliteration",
      providerApi: "openai-responses",
      baseUrl: "https://api.abliteration.ai/v1",
      legacyApi: "openai-completions",
    });
    const ids = provider?.models.map((m) => m.id);
    expect(provider?.authHeader).toBe(true);
    expect(ids).toContain("old-model");
    expect(ids).toContain(ABLITERATION_DEFAULT_MODEL_REF.replace(/^abliteration\//, ""));
  });

  it("preserves SecretRef apiKey values when reapplying provider config", () => {
    const apiKey = { source: "env", provider: "default", id: "ABLITERATION_API_KEY" } as const;
    const next = applyAbliterationProviderConfig({
      models: {
        providers: {
          abliteration: {
            api: "openai-completions",
            baseUrl: "https://legacy.abliteration.ai/v1",
            apiKey,
            models: [],
          },
        },
      },
    });

    expect(next.models?.providers?.abliteration?.apiKey).toEqual(apiKey);
  });

  it("rewrites normalized variant provider keys in place", () => {
    const next = applyAbliterationProviderConfig({
      models: {
        providers: {
          Abliteration: {
            api: "openai-completions",
            baseUrl: "https://legacy.abliteration.ai/v1",
            apiKey: "  test-key  ",
            models: [
              {
                id: "old-model",
                name: "Old Model",
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 4096,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    });

    expect(next.models?.providers?.Abliteration).toBeUndefined();
    expect(Object.keys(next.models?.providers ?? {})).toEqual(["abliteration"]);
    expect(next.models?.providers?.abliteration).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.abliteration.ai/v1",
      authHeader: true,
      apiKey: "test-key",
    });
    expect(next.models?.providers?.abliteration?.models.map((model) => model.id)).toEqual([
      "old-model",
      "abliterated-model",
    ]);
  });
});
