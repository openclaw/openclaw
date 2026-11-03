import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue as primary } from "openclaw/plugin-sdk/provider-onboard";
import { assert, expect, it } from "vitest";
import { createNoBrowserAuth } from "../test-support/no-browser-auth.test-support.js";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const COHERE_BASE_URL = "https://api.cohere.ai/compatibility/v1";
const COHERE_DEFAULT_MODEL_REF = `cohere/${manifest.modelCatalog.providers.cohere.defaultModel}`;

async function configureCohere(config: OpenClawConfig) {
  const provider = await registerSingleProviderPlugin(plugin);
  const auth = provider.auth.find((method) => method.id === "api-key");
  assert(auth, "Cohere API-key auth was not registered");
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
  assert(result.configPatch, "Cohere auth did not configure the provider");
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
    "command-a-plus-05-2026",
    "command-a-03-2025",
    "command-a-reasoning-08-2025",
    "command-a-vision-07-2025",
    "north-mini-code-1-0",
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
