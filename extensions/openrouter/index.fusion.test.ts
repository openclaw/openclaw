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

function fusionModels(fields: Record<string, unknown>, key = "openrouter/fusion") {
  return { [key]: { params: { extraBody: fusionBody(fields) } } };
}

function fusionBody(fields: Record<string, unknown>) {
  return { plugins: [{ id: "fusion", ...fields }] };
}

describe("openrouter Fusion prompt hooks", () => {
  it("keeps bounded Fusion model IDs on valid UTF-16 boundaries", () => {
    const boundaryModelId = `${"a".repeat(255)}😀tail`;
    const contribution = resolveContribution({
      defaults: {
        models: fusionModels(
          { analysis_models: [boundaryModelId], model: boundaryModelId },
          "openrouter/openrouter/fusion",
        ),
      },
    });

    expect(contribution?.dynamicSuffix).toContain(`Analysis models: ${"a".repeat(255)}.`);
    expect(contribution?.dynamicSuffix).toContain(`Final Fusion model: ${"a".repeat(255)}.`);
  });

  it("matches transport alias precedence for Fusion extra body", () => {
    const contribution = resolveContribution({
      defaults: {
        params: { extra_body: fusionBody({ analysis_models: ["google/gemini-3.5-flash"] }) },
        models: fusionModels({ analysis_models: ["deepseek/deepseek-v4-pro"] }),
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
            params: { extraBody: fusionBody({ analysis_models: ["deepseek/deepseek-v4-pro"] }) },
          },
        },
      },
      "reviewer",
    );

    expect(contribution?.dynamicSuffix).toContain("Analysis models: deepseek/deepseek-v4-pro.");
  });

  it("uses the bound agent's model-specific Fusion configuration", () => {
    const contribution = resolveContribution(
      {
        defaults: { models: fusionModels({ model: "default/model" }) },
        entries: {
          reviewer: {
            models: fusionModels({ model: "reviewer/model" }, "openrouter/openrouter/fusion"),
          },
        },
      },
      "reviewer",
    );

    expect(contribution?.dynamicSuffix).toContain("Final Fusion model: reviewer/model.");
    expect(contribution?.dynamicSuffix).not.toContain("default/model");
  });

  it.each([
    {
      metadata: { private: "do-not-render" },
      plugins: [{ id: "not-fusion", model: "private-model" }],
    },
    fusionBody({
      enabled: false,
      analysis_models: ["deepseek/deepseek-v4-pro"],
      model: "google/gemini-3.5-flash",
    }),
  ])("omits non-Fusion and disabled extraBody from the prompt: %j", (extraBody) => {
    const contribution = resolveContribution({
      defaults: {
        models: { "openrouter/openrouter/fusion": { params: { extraBody } } },
      },
    });

    expect(contribution).toBeUndefined();
  });
});
