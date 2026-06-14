// Opencode Go tests cover onboard plugin behavior.
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { expectProviderOnboardPrimaryAndFallbacks } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { applyOpencodeGoConfig, applyOpencodeGoProviderConfig } from "./onboard.js";

const MODEL_REF = "opencode-go/kimi-k2.6";
const EXPECTED_MODEL_IDS = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5",
  "glm-5.1",
  "hy3-preview",
  "kimi-k2.5",
  "kimi-k2.6",
  "kimi-k2.7-code",
  "mimo-v2-omni",
  "mimo-v2.5",
  "mimo-v2-pro",
  "mimo-v2.5-pro",
  "minimax-m2.5",
  "minimax-m2.7",
  "minimax-m3",
  "qwen3.5-plus",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-plus",
] as const;

describe("opencode-go onboard", () => {
  it("adds the bundled Go catalog and default alias", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {},
        },
      },
    };

    const next = applyOpencodeGoProviderConfig(cfg);
    expect(next.models?.providers?.["opencode-go"]?.api).toBe("openai-completions");
    expect(next.models?.providers?.["opencode-go"]?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(next.models?.providers?.["opencode-go"]?.models?.map((model) => model.id)).toEqual([
      ...EXPECTED_MODEL_IDS,
    ]);
    expect(next.agents?.defaults?.models?.[MODEL_REF]).toEqual({ alias: "Kimi" });
    expect(resolveAgentModelPrimaryValue(next.agents?.defaults?.model)).toBeUndefined();
  });

  it("sets primary model and preserves existing model fallbacks", () => {
    expectProviderOnboardPrimaryAndFallbacks({
      applyConfig: applyOpencodeGoConfig,
      modelRef: MODEL_REF,
    });
  });

  it("keeps existing opencode-go provider rows when applying the full preset", () => {
    const cfg = applyOpencodeGoConfig({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            [MODEL_REF]: { alias: "Custom Kimi" },
          },
        },
      },
      models: {
        providers: {
          "opencode-go": {
            api: "openai-completions",
            baseUrl: "https://opencode.ai/zen/go/v1",
            models: [
              {
                id: "custom-model",
                name: "Custom Model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 4096,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    });

    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(MODEL_REF);
    expect(cfg.agents?.defaults?.models?.[MODEL_REF]).toEqual({ alias: "Custom Kimi" });
    expect(cfg.models?.providers?.["opencode-go"]?.models?.map((model) => model.id)).toEqual([
      "custom-model",
      ...EXPECTED_MODEL_IDS,
    ]);
  });
});
