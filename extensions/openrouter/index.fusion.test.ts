import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import openrouterPlugin from "./index.js";

let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});

function resolveContribution(agents: OpenClawConfig["agents"], agentId?: string) {
  return provider.resolveSystemPromptContribution?.({
    provider: "openrouter",
    modelId: "openrouter/fusion",
    promptMode: "full",
    config: { agents },
    agentId,
  });
}

function createFusionModelConfig(modelKey: string, extraBody: Record<string, unknown>) {
  return {
    defaults: { models: { [modelKey]: { params: { extraBody } } } },
  };
}

function fusionBody(fields: Record<string, unknown>) {
  return { plugins: [{ id: "fusion", ...fields }] };
}

describe("openrouter Fusion prompt hooks", () => {
  it("describes configured Fusion analysis models in the system prompt", () => {
    const contribution = resolveContribution(
      createFusionModelConfig(
        "openrouter/openrouter/fusion",
        fusionBody({
          analysis_models: [
            "google/gemini-3.5-flash",
            "moonshotai/kimi-k2.6",
            "deepseek/deepseek-v4-pro",
          ],
          model: "google/gemini-3.5-flash",
        }),
      ),
    );

    expect(contribution?.dynamicSuffix).toContain("OpenRouter Fusion Configuration");
    expect(contribution?.dynamicSuffix).toContain(
      "Analysis models: google/gemini-3.5-flash, moonshotai/kimi-k2.6, deepseek/deepseek-v4-pro.",
    );
    expect(contribution?.dynamicSuffix).toContain("Final Fusion model: google/gemini-3.5-flash.");
  });

  it("keeps bounded Fusion model IDs on valid UTF-16 boundaries", () => {
    const boundaryModelId = `${"a".repeat(255)}😀tail`;
    const contribution = resolveContribution(
      createFusionModelConfig(
        "openrouter/fusion",
        fusionBody({
          analysis_models: [boundaryModelId],
          model: boundaryModelId,
        }),
      ),
    );

    expect(contribution?.dynamicSuffix).toContain(`Analysis models: ${"a".repeat(255)}.`);
    expect(contribution?.dynamicSuffix).toContain(`Final Fusion model: ${"a".repeat(255)}.`);
  });

  it("matches transport alias precedence for Fusion extra body", () => {
    const contribution = resolveContribution({
      defaults: {
        params: { extra_body: fusionBody({ analysis_models: ["google/gemini-3.5-flash"] }) },
        models: {
          "openrouter/fusion": {
            params: {
              extraBody: fusionBody({ analysis_models: ["deepseek/deepseek-v4-pro"] }),
            },
          },
        },
      },
    });

    expect(contribution?.dynamicSuffix).toContain("Analysis models: google/gemini-3.5-flash.");
    expect(contribution?.dynamicSuffix).not.toContain("deepseek/deepseek-v4-pro");
  });

  it("reads per-agent Fusion config from the canonical agent roster", () => {
    const contribution = resolveContribution(
      {
        entries: {
          reviewer: {
            params: {
              extraBody: fusionBody({ analysis_models: ["deepseek/deepseek-v4-pro"] }),
            },
          },
        },
      },
      "reviewer",
    );

    expect(contribution?.dynamicSuffix).toContain("Analysis models: deepseek/deepseek-v4-pro.");
  });

  it("keeps arbitrary OpenRouter extraBody fields out of the system prompt", () => {
    const contribution = resolveContribution(
      createFusionModelConfig("openrouter/openrouter/fusion", {
        metadata: { private: "do-not-render" },
        plugins: [{ id: "not-fusion", model: "private-model" }],
      }),
    );

    expect(contribution).toBeUndefined();
  });

  it("does not describe disabled Fusion plugin config in the system prompt", () => {
    const contribution = resolveContribution(
      createFusionModelConfig(
        "openrouter/fusion",
        fusionBody({
          enabled: false,
          analysis_models: ["deepseek/deepseek-v4-pro"],
          model: "google/gemini-3.5-flash",
        }),
      ),
    );

    expect(contribution).toBeUndefined();
  });
});
