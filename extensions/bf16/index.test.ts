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
import { buildBf16Provider } from "./models.js";

const defaultModel = "bf16/deepseek/deepseek-v4.1-flash-uncensored";

it("registers API-key onboarding with the default model and connection", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("bf16");
  expect(provider.envVars).toEqual(["BF16_API_KEY"]);
  const method = resolveProviderPluginChoice({
    providers: [provider],
    choice: "bf16-api-key",
  })?.method;
  expect(method?.starterModel).toBe(defaultModel);
  assert(method?.runNonInteractive, "Missing bf16.ai API-key onboarding");
  const resolveApiKey = vi.fn(async () => ({ key: "synthetic-key", source: "profile" as const }));
  const config = await method.runNonInteractive({
    authChoice: "bf16-api-key",
    opts: { bf16ApiKey: "synthetic-key" },
    config: {},
    baseConfig: {},
    runtime: createRuntimeEnv(),
    resolveApiKey,
    toApiKeyCredential: () => null,
  });
  expect(resolveApiKey).toHaveBeenCalledWith({
    provider: "bf16",
    flagValue: "synthetic-key",
    flagName: "--bf16-api-key",
    envVar: "BF16_API_KEY",
  });
  expect(config?.models?.providers?.bf16).toMatchObject({
    baseUrl: "https://api.bf16.ai/v1",
    api: "openai-completions",
  });
  expect(resolveAgentModelPrimaryValue(config?.agents?.defaults?.model)).toBe(defaultModel);
  expect(config?.agents?.defaults?.models?.[defaultModel]?.alias).toBe(
    "DeepSeek V4.1 Flash (Uncensored)",
  );
});

it("preserves existing custom bf16 settings and agent aliases across connection-only setup", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  const method = resolveProviderPluginChoice({
    providers: [provider],
    choice: "bf16-api-key",
  })?.method;
  assert(method?.runNonInteractive, "Missing bf16.ai API-key onboarding");
  const existingConfig = {
    models: {
      providers: {
        bf16: {
          baseUrl: "https://api.bf16.ai/v1",
          api: "openai-completions" as const,
          models: [
            {
              id: "zai-org/glm-5.3-uncensored",
              name: "Custom GLM-5.3",
              reasoning: true,
              input: ["text" as const],
              contextWindow: 1048576,
              maxTokens: 131072,
              cost: { input: 1.35, output: 4.2, cacheRead: 0.25, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "bf16/zai-org/glm-5.3-uncensored",
          fallbacks: ["bf16/bf16/auto"],
        },
        models: {
          "bf16/zai-org/glm-5.3-uncensored": { alias: "my-glm" },
        },
      },
    },
  };
  const next = await method.runNonInteractive({
    authChoice: "bf16-api-key",
    opts: { bf16ApiKey: "synthetic-key" },
    config: existingConfig,
    baseConfig: existingConfig,
    runtime: createRuntimeEnv(),
    resolveApiKey: async () => ({ key: "synthetic-key", source: "profile" as const }),
    toApiKeyCredential: () => null,
  });
  expect(
    typeof next?.agents?.defaults?.model === "object"
      ? next.agents.defaults.model.fallbacks
      : undefined,
  ).toEqual(["bf16/bf16/auto"]);
  expect(next?.agents?.defaults?.models?.["bf16/zai-org/glm-5.3-uncensored"]?.alias).toBe("my-glm");
  expect(next?.models?.providers?.bf16?.baseUrl).toBe("https://api.bf16.ai/v1");
  expect(next?.models?.providers?.bf16?.models?.map((entry) => entry.id)).toEqual([
    "zai-org/glm-5.3-uncensored",
  ]);
});

it("builds stateless Chat Completions requests with max_tokens", () => {
  const provider = buildBf16Provider();
  const model = provider.models.find(
    (entry) => entry.id === "deepseek/deepseek-v4.1-flash-uncensored",
  );
  assert(model, "Missing default bf16.ai model");
  const payload = buildOpenAICompletionsParams(
    {
      ...model,
      input: model.input.filter((input) => input === "text" || input === "image"),
      provider: "bf16",
      baseUrl: provider.baseUrl,
      api: "openai-completions",
    },
    { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
    { maxTokens: 1024 },
  );
  expect(payload.max_tokens).toBe(1024);
  expect(payload).not.toHaveProperty("store");
});
