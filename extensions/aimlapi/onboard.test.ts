import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import {
  applyAimlapiConfig,
  applyAimlapiProviderConfig,
  AIMLAPI_DEFAULT_MODEL_REF,
} from "./onboard.js";

describe("AIMLAPI onboard config", () => {
  it("seeds provider defaults before selecting the AIMLAPI primary model", () => {
    const result = applyAimlapiConfig({});

    expect(result.agents?.defaults?.model).toEqual({
      primary: AIMLAPI_DEFAULT_MODEL_REF,
    });
    expect(result.agents?.defaults?.models?.[AIMLAPI_DEFAULT_MODEL_REF]).toMatchObject({
      alias: "AI/ML API",
    });
    expect(result.models?.providers?.aimlapi).toMatchObject({
      baseUrl: "https://api.aimlapi.com/v1",
      api: "openai-completions",
    });
    expect(result.models?.providers?.aimlapi?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "openai/gpt-5-nano-2025-08-07",
        }),
      ]),
    );
  });

  it("preserves unrelated provider config while adding AIMLAPI defaults", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.4": {
              alias: "GPT-5.4",
            },
          },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            models: [
              {
                id: "gpt-5.4",
                name: "GPT-5.4",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
            ],
          },
        },
      },
    };

    const result = applyAimlapiProviderConfig(config);

    expect(result.models?.providers?.openai).toEqual(config.models?.providers?.openai);
    expect(result.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual(
      config.agents?.defaults?.models?.["openai/gpt-5.4"],
    );
    expect(result.models?.providers?.aimlapi).toBeDefined();
    expect(result.agents?.defaults?.models?.[AIMLAPI_DEFAULT_MODEL_REF]).toMatchObject({
      alias: "AI/ML API",
    });
  });
});
