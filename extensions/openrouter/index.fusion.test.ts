import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeAll, expect, it } from "vitest";
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
  return { [key]: modelEntry(fusionBody(fields)) };
}
function modelEntry(extraBody: Record<string, unknown>) {
  return { params: { extraBody } };
}
function fusionBody(fields: Record<string, unknown>) {
  return { plugins: [{ id: "fusion", ...fields }] };
}

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
      params: { extra_body: fusionBody({ analysis_models: ["analysis/a"] }) },
      models: fusionModels({ analysis_models: ["analysis/b"] }),
    },
  });

  expect(contribution?.dynamicSuffix).toContain("Analysis models: analysis/a.");
  expect(contribution?.dynamicSuffix).not.toContain("analysis/b");
});

it("reads per-agent Fusion config from the canonical agent roster", () => {
  const contribution = resolveContribution(
    { entries: { reviewer: modelEntry(fusionBody({ analysis_models: ["analysis/b"] })) } },
    "reviewer",
  );

  expect(contribution?.dynamicSuffix).toContain("Analysis models: analysis/b.");
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
    analysis_models: ["analysis/b"],
    model: "final/model",
  }),
])("omits non-Fusion and disabled extraBody from the prompt: %j", (extraBody) => {
  const contribution = resolveContribution({
    defaults: { models: { "openrouter/openrouter/fusion": modelEntry(extraBody) } },
  });

  expect(contribution).toBeUndefined();
});
