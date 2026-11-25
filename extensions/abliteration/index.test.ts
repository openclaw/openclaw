import assert from "node:assert/strict";
import {
  createRuntimeEnv,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
import { buildAbliterationProvider } from "./models.js";

const defaultModel = "abliteration/abliterated-model-large-flash";

it("registers API-key onboarding with the default model and connection", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("abliteration");
  expect(provider.envVars).toEqual(["ABLITERATION_API_KEY", "ABLIT_KEY"]);
  const method = resolveProviderPluginChoice({
    providers: [provider],
    choice: "abliteration-api-key",
  })?.method;
  expect(method?.starterModel).toBe(defaultModel);
  assert(method?.runNonInteractive, "Missing Abliteration API-key onboarding");
  const resolveApiKey = vi.fn(async () => ({ key: "synthetic-key", source: "profile" as const }));
  const config = await method.runNonInteractive({
    authChoice: "abliteration-api-key",
    opts: { abliterationApiKey: "synthetic-key" },
    config: {},
    baseConfig: {},
    runtime: createRuntimeEnv(),
    resolveApiKey,
    toApiKeyCredential: () => null,
  });
  expect(resolveApiKey).toHaveBeenCalledWith({
    provider: "abliteration",
    flagValue: "synthetic-key",
    flagName: "--abliteration-api-key",
    envVar: "ABLITERATION_API_KEY",
  });
  expect(config?.models?.providers?.abliteration).toMatchObject({
    baseUrl: "https://api.abliteration.ai/v1",
    api: "openai-completions",
  });
  expect(resolveAgentModelPrimaryValue(config?.agents?.defaults?.model)).toBe(defaultModel);
  expect(config?.agents?.defaults?.models?.[defaultModel]?.alias).toBe("Abliterated Large Flash");
});

it("publishes the default model in the static catalog without credentials", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await provider.staticCatalog?.run({} as never);
  assert(catalog && "provider" in catalog, "Missing static Abliteration catalog");
  expect(catalog.provider.models[0]?.id).toBe("abliterated-model-large-flash");
});

it("sends native reasoning efforts and cache keys through Chat Completions", () => {
  const provider = buildAbliterationProvider();
  for (const [id, reasoning, effort] of [
    ["abliterated-model-large-flash", "off", "none"],
    ["abliterated-model-large-v2", "high", "high"],
    ["abliterated-model-large-v2", "off", "low"],
    ["abliterated-model-large-v2", "medium", "low"],
  ] as const) {
    const model = provider.models.find((entry) => entry.id === id);
    assert(model, `Missing Abliteration model ${id}`);
    const payload = buildOpenAICompletionsParams(
      {
        ...model,
        input: model.input.filter((input) => input === "text" || input === "image"),
        provider: "abliteration",
        baseUrl: provider.baseUrl,
        api: "openai-completions",
      },
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { reasoning, sessionId: "synthetic-session", maxTokens: 1024, cacheRetention: "long" },
    );
    expect(payload.reasoning_effort).toBe(effort);
    expect(payload.prompt_cache_key).toBe("synthetic-session");
    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  }
});
