import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveAgentModelPrimaryValue as primary } from "openclaw/plugin-sdk/provider-onboard";
import { expect, it } from "vitest";
import { createNoBrowserAuth } from "../test-support/no-browser-auth.test-support.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const COHERE_BASE_URL = "https://api.cohere.ai/compatibility/v1";
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
    ...createNoBrowserAuth(),
  });
  if (!result.configPatch) {
    throw new Error("Cohere auth did not configure the provider");
  }
  return result.configPatch;
}

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
  const result = await configureCohere({
    agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
  });

  expect(primary(result.agents?.defaults?.model)).toBe("openai/gpt-5.5");
  expect(result.agents?.defaults?.models?.[COHERE_DEFAULT_MODEL_REF]).toEqual({
    alias: "Cohere Command A+",
  });
});

it("uses Cohere as the first configured primary model", async () => {
  const result = await configureCohere({});

  expect(result.models?.providers?.cohere?.models).toEqual([]);
  expect(primary(result.agents?.defaults?.model)).toBe(COHERE_DEFAULT_MODEL_REF);
});

it("preserves authored rows in merge mode", async () => {
  const plainCompat = {
    supportsStore: false,
    supportsUsageInStreaming: false,
    maxTokensField: "max_tokens" as const,
  };
  const model = (id: string, overrides: Partial<ModelDefinitionConfig>): ModelDefinitionConfig => ({
    id: `operator-${id}`,
    name: "My model",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 64000,
    compat: {
      ...plainCompat,
      supportsReasoningEffort: true,
      supportedReasoningEfforts: ["none", "high"],
      reasoningEffortMap: { off: "none", medium: "high" },
    },
    ...overrides,
  });
  const authored: ModelDefinitionConfig[] = [
    model(COHERE_DEFAULT_MODEL_ID, {
      input: ["text", "image"],
      contextWindow: 128000,
    }),
    model("command-a-03-2025", {
      reasoning: false,
      cost: { input: 2.5, output: 10, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 8000,
      compat: plainCompat,
    }),
    model(COHERE_COMMAND_A_REASONING_MODEL_ID, { maxTokens: 32000 }),
    model(COHERE_COMMAND_A_VISION_MODEL_ID, {
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 128000,
      maxTokens: 8000,
      compat: plainCompat,
    }),
    model(COHERE_NORTH_MINI_CODE_MODEL_ID, {}),
  ];
  const result = await configureCohere({
    models: {
      mode: "merge",
      providers: { cohere: { baseUrl: COHERE_BASE_URL, models: authored } },
    },
  });

  expect(result.models?.providers?.cohere?.models).toEqual(authored);
});
