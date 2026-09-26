import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

function createFusionModelConfig(modelKey: string, extraBody: Record<string, unknown>) {
  return {
    agents: {
      defaults: {
        models: {
          [modelKey]: { params: { extraBody } },
        },
      },
    },
  };
}

describe("openrouter Fusion system prompt", () => {
  it("describes configured Fusion analysis models in the system prompt", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: createFusionModelConfig("openrouter/openrouter/fusion", {
        plugins: [
          {
            id: "fusion",
            analysis_models: [
              "google/gemini-3.5-flash",
              "moonshotai/kimi-k2.6",
              "deepseek/deepseek-v4-pro",
            ],
            model: "google/gemini-3.5-flash",
          },
        ],
      }),
    } as never);

    expect(contribution?.dynamicSuffix).toContain("OpenRouter Fusion Configuration");
    expect(contribution?.dynamicSuffix).toContain(
      "Analysis models: google/gemini-3.5-flash, moonshotai/kimi-k2.6, deepseek/deepseek-v4-pro.",
    );
    expect(contribution?.dynamicSuffix).toContain("Final Fusion model: google/gemini-3.5-flash.");
  });

  it("keeps bounded Fusion model IDs on valid UTF-16 boundaries", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const boundaryModelId = `${"a".repeat(255)}😀tail`;
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: createFusionModelConfig("openrouter/fusion", {
        plugins: [
          {
            id: "fusion",
            analysis_models: [boundaryModelId],
            model: boundaryModelId,
          },
        ],
      }),
    } as never);

    expect(contribution?.dynamicSuffix).toContain(`Analysis models: ${"a".repeat(255)}.`);
    expect(contribution?.dynamicSuffix).toContain(`Final Fusion model: ${"a".repeat(255)}.`);
  });

  it("describes Fusion config from the canonical OpenRouter model key", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: createFusionModelConfig("openrouter/fusion", {
        plugins: [
          {
            id: "fusion",
            analysis_models: ["deepseek/deepseek-v4-pro"],
          },
        ],
      }),
    } as never);

    expect(contribution?.dynamicSuffix).toContain("Analysis models: deepseek/deepseek-v4-pro.");
  });

  it("matches transport alias precedence for Fusion extra body", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            params: {
              extra_body: {
                plugins: [
                  {
                    id: "fusion",
                    analysis_models: ["google/gemini-3.5-flash"],
                  },
                ],
              },
            },
            models: {
              "openrouter/fusion": {
                params: {
                  extraBody: {
                    plugins: [
                      {
                        id: "fusion",
                        analysis_models: ["deepseek/deepseek-v4-pro"],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution?.dynamicSuffix).toContain("Analysis models: google/gemini-3.5-flash.");
    expect(contribution?.dynamicSuffix).not.toContain("deepseek/deepseek-v4-pro");
  });

  it("reads per-agent Fusion config from the canonical agent roster", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      agentId: "reviewer",
      config: {
        agents: {
          entries: {
            reviewer: {
              params: {
                extraBody: {
                  plugins: [{ id: "fusion", analysis_models: ["deepseek/deepseek-v4-pro"] }],
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution?.dynamicSuffix).toContain("Analysis models: deepseek/deepseek-v4-pro.");
  });

  it("keeps arbitrary OpenRouter extraBody fields out of the system prompt", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: {
        agents: {
          defaults: {
            models: {
              "openrouter/openrouter/fusion": {
                params: {
                  extraBody: {
                    metadata: { private: "do-not-render" },
                    plugins: [{ id: "not-fusion", model: "private-model" }],
                  },
                },
              },
            },
          },
        },
      },
    } as never);

    expect(contribution).toBeUndefined();
  });

  it("does not describe disabled Fusion plugin config in the system prompt", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const contribution = provider.resolveSystemPromptContribution?.({
      provider: "openrouter",
      modelId: "openrouter/fusion",
      promptMode: "full",
      config: createFusionModelConfig("openrouter/fusion", {
        plugins: [
          {
            id: "fusion",
            enabled: false,
            analysis_models: ["deepseek/deepseek-v4-pro"],
            model: "google/gemini-3.5-flash",
          },
        ],
      }),
    } as never);

    expect(contribution).toBeUndefined();
  });
});
