import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { buildCohereCatalogModels, COHERE_BASE_URL } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const COHERE_DEFAULT_MODEL_REF = `cohere/${manifest.modelCatalog.providers.cohere.defaultModel}`;
const COHERE_DEFAULT_MODEL_ID = "command-a-plus-05-2026";
const COHERE_COMMAND_A_REASONING_MODEL_ID = "command-a-reasoning-08-2025";
const COHERE_COMMAND_A_VISION_MODEL_ID = "command-a-vision-07-2025";
const COHERE_NORTH_MINI_CODE_MODEL_ID = "north-mini-code-1-0";

async function configureCohere(config: OpenClawConfig) {
  const provider = await registerSingleProviderPlugin(plugin);
  const auth = provider.auth.find((method) => method.id === "api-key");
  if (!auth) {
    throw new Error("Cohere API-key auth was not registered");
  }
  const result = await auth.run({
    config,
    opts: { cohereApiKey: "synthetic-cohere-key" },
    env: {},
    runtime: createRuntimeEnv(),
    prompter: createTestWizardPrompter(),
    secretInputMode: "plaintext",
    isRemote: false,
    openUrl: async () => {
      throw new Error("Unexpected browser auth");
    },
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected OAuth");
      },
    },
  });
  if (!result.configPatch) {
    throw new Error("Cohere auth did not configure the provider");
  }
  return result.configPatch;
}

describe("Cohere onboarding", () => {
  it("registers the manifest catalog through registered auth", async () => {
    const result = await configureCohere({ models: { mode: "replace" } });
    const provider = result.models?.providers?.cohere;

    expect(provider).toMatchObject({
      baseUrl: COHERE_BASE_URL,
      api: "openai-completions",
    });
    expect(provider?.models?.map((model) => model.id)).toEqual([
      COHERE_DEFAULT_MODEL_ID,
      "command-a-03-2025",
      COHERE_COMMAND_A_REASONING_MODEL_ID,
      COHERE_COMMAND_A_VISION_MODEL_ID,
      COHERE_NORTH_MINI_CODE_MODEL_ID,
    ]);
  });

  it("sets Cohere only when there is no primary model", async () => {
    const existing: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
        },
      },
    };

    const result = await configureCohere(existing);

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5.5");
    expect(result.agents?.defaults?.models?.[COHERE_DEFAULT_MODEL_REF]).toEqual({
      alias: "Cohere Command A+",
    });
  });

  it("uses Cohere as the first configured primary model", async () => {
    const result = await configureCohere({});

    expect(result.models?.providers?.cohere?.models).toEqual([]);
    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe(
      COHERE_DEFAULT_MODEL_REF,
    );
  });

  it("preserves authored rows in merge mode", async () => {
    const authored = buildCohereCatalogModels().map((model) =>
      Object.assign({}, model, { id: `operator-${model.id}`, name: "My model" }),
    );
    const result = await configureCohere({
      models: {
        mode: "merge",
        providers: { cohere: { baseUrl: COHERE_BASE_URL, models: authored } },
      },
    });

    expect(result.models?.providers?.cohere?.models).toEqual(authored);
  });
});
