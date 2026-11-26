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
import { buildNodecodeProvider } from "./models.js";

const defaultModel = "nodecode/nodecode-cyber-v1";

it("registers API-key onboarding with Cyber v1 as the default model", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  expect(provider.id).toBe("nodecode");
  expect(provider.envVars).toEqual(["NODECODE_API_KEY"]);
  const method = resolveProviderPluginChoice({
    providers: [provider],
    choice: "nodecode-api-key",
  })?.method;
  expect(method?.starterModel).toBe(defaultModel);
  assert(method?.runNonInteractive, "Missing Nodecode API-key onboarding");
  const resolveApiKey = vi.fn(async () => ({ key: "synthetic-key", source: "profile" as const }));
  const config = await method.runNonInteractive({
    authChoice: "nodecode-api-key",
    opts: { nodecodeApiKey: "synthetic-key" },
    config: {},
    baseConfig: {},
    runtime: createRuntimeEnv(),
    resolveApiKey,
    toApiKeyCredential: () => null,
  });
  expect(resolveApiKey).toHaveBeenCalledWith({
    provider: "nodecode",
    flagValue: "synthetic-key",
    flagName: "--nodecode-api-key",
    envVar: "NODECODE_API_KEY",
  });
  expect(config?.models?.providers?.nodecode).toMatchObject({
    baseUrl: "https://api.nodecode.ai/v1",
    api: "openai-completions",
  });
  expect(resolveAgentModelPrimaryValue(config?.agents?.defaults?.model)).toBe(defaultModel);
  expect(config?.agents?.defaults?.models?.[defaultModel]?.alias).toBe("Cyber v1");
});

it("publishes Cyber v1 in the static catalog without credentials", async () => {
  const provider = await registerSingleProviderPlugin(plugin);
  const catalog = await provider.staticCatalog?.run({} as never);
  assert(catalog && "provider" in catalog, "Missing static Nodecode catalog");
  expect(catalog.provider.models.map((model) => model.id)).toEqual(["nodecode-cyber-v1"]);
});

it("sends every thinking level as Cyber v1's own reasoning effort, with the session's cache key", () => {
  const provider = buildNodecodeProvider();
  const model = provider.models.find((entry) => entry.id === "nodecode-cyber-v1");
  assert(model, "Missing Cyber v1 in the Nodecode catalog");
  for (const [reasoning, effort] of [
    ["off", "none"],
    ["minimal", "minimal"],
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["xhigh", "xhigh"],
    ["max", "max"],
  ] as const) {
    const payload = buildOpenAICompletionsParams(
      {
        ...model,
        input: model.input.filter((input) => input === "text"),
        provider: "nodecode",
        baseUrl: provider.baseUrl,
        api: "openai-completions",
      },
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      { reasoning, sessionId: "synthetic-session", maxTokens: 1024, cacheRetention: "long" },
    );
    expect(payload.reasoning_effort).toBe(effort);
    expect(payload.prompt_cache_key).toBe("synthetic-session");
    expect(payload.max_tokens).toBe(1024);
    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
  }
});
