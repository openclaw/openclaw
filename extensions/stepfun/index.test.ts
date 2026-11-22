import type { Context, Model } from "openclaw/plugin-sdk/llm";
import * as plugins from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { assert, describe, expect, it } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import stepfunPlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const registerStepFun = () =>
  plugins.registerProviderPlugin({ plugin: stepfunPlugin, id: "stepfun", name: "StepFun" });

async function applyConfig(providerId: string, methodId: string, config: OpenClawConfig) {
  const { providers } = await registerStepFun();
  const provider = plugins.requireRegisteredProvider(providers, providerId);
  const method = provider.auth.find((entry) => entry.id === methodId);
  assert(method?.runNonInteractive && method.wizard?.choiceId, `Missing auth method ${methodId}`);
  const result = await method.runNonInteractive({
    authChoice: method.wizard.choiceId,
    config,
    baseConfig: config,
    opts: {},
    runtime: createRuntimeSpies(),
    resolveApiKey: async () => ({ key: "fixture-value", source: "profile" as const }),
    toApiKeyCredential: () => null,
  });
  assert(result, "StepFun setup did not return a configuration");
  return result;
}

const catalogModels = ["step-3.7-flash", "step-3.5-flash"];
describe.each([
  ["stepfun", "standard-api-key-intl", undefined, catalogModels],
  ["stepfun-plan", "plan-api-key-cn", "merge", [...catalogModels, "step-3.5-flash-2603"]],
] as const)("%s setup", (providerId, methodId, mode, rows) => {
  const apply = (config: OpenClawConfig) => applyConfig(providerId, methodId, config);

  it("leaves ordinary rows runtime-owned and retains aliases", async () => {
    const config = await apply({ models: { mode } });

    expect(config.models?.providers?.[providerId]?.models).toEqual([]);
    expect(config.agents?.defaults?.models?.[`${providerId}/step-3.7-flash`]).toEqual({});
    const alias = config.agents?.defaults?.models?.[`${providerId}/step-3.5-flash`]?.alias;
    expect(alias).toEqual(expect.any(String));
    expect(await apply(config)).toEqual(config);
  });

  it("retains the shipped replace catalog", async () => {
    const config = await apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[providerId]?.models.map((model) => model.id)).toEqual(rows);
  });
});

it("adds Step 3.7 Flash without changing existing defaults", async () => {
  const { providers } = await registerStepFun();
  async function catalog(providerId: string) {
    const registration = plugins.requireRegisteredProvider(providers, providerId);
    const result = await registration.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
    assert(result && "provider" in result, `Missing ${providerId} catalog`);
    expect(registration.auth[0]?.starterModel).toBe(`${providerId}/step-3.5-flash`);
    return result.provider;
  }
  const standard = await catalog("stepfun");
  const plan = await catalog("stepfun-plan");
  const standard35 = standard.models?.find((model) => model.id === "step-3.5-flash");
  expect(standard35?.compat?.supportsReasoningEffort).not.toBe(true);
  expect(standard35?.cost).toEqual({ input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 });
  for (const [provider, cost] of [
    [standard, { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 }],
    [plan, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
  ] as const) {
    const model = provider.models?.find((entry) => entry.id === "step-3.7-flash");
    assert(model, "Missing Step 3.7 Flash");
    expect(model).toMatchObject({
      cost,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "high", max: "high" },
      contextWindow: 262144,
      maxTokens: 262144,
      compat: {
        supportsReasoningEffort: true,
        supportsStrictMode: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
        reasoningEffortMap: { off: "low", medium: "medium", max: "high" },
      },
    });
    const transportModel = {
      ...model,
      provider: provider === standard ? "stepfun" : "stepfun-plan",
      api: "openai-completions",
      baseUrl: provider.baseUrl,
    } as Model<"openai-completions">;
    const context: Context = { systemPrompt: "system", messages: [] };
    const payloadFor = (reasoning: string | undefined, maxTokens?: number) =>
      buildOpenAICompletionsParams(transportModel, context, { reasoning, maxTokens } as never);
    const lowPayload = payloadFor(model.thinkingLevelMap?.off ?? undefined, 128);
    expect(lowPayload).toMatchObject({ reasoning_effort: "low", max_tokens: 128 });
    for (const key of ["max_completion_tokens", "store", "stream_options"]) {
      expect(lowPayload).not.toHaveProperty(key);
    }
    expect(lowPayload.messages).toContainEqual({ role: "system", content: "system" });
    expect(lowPayload.messages).not.toContainEqual(expect.objectContaining({ role: "developer" }));
    expect(payloadFor("high").reasoning_effort).toBe("high");
  }
});

it("keeps manifest auth choices aligned with runtime provider methods", async () => {
  const { providers } = await registerStepFun();
  const runtimeChoices = ["stepfun", "stepfun-plan"].flatMap((providerId) => {
    const provider = plugins.requireRegisteredProvider(providers, providerId);
    return provider.auth.map((method) => [provider.id, method.id, method.wizard?.choiceId]);
  });

  const choices = manifest.providerAuthChoices.map((c) => [c.provider, c.method, c.choiceId]);
  expect(runtimeChoices).toEqual(choices);
  expect(manifest.setup.providers).toEqual([
    { id: "stepfun", envVars: ["STEPFUN_API_KEY"] },
    { id: "stepfun-plan", envVars: ["STEPFUN_API_KEY"] },
  ]);
});

it.each([
  ["stepfun", "standard-api-key-cn"],
  ["stepfun-plan", "plan-api-key-intl"],
])("preserves primary during %s/%s onboarding", async (providerId, methodId) => {
  const primary = "anthropic/claude-sonnet-4-6";
  const model = { primary, fallbacks: ["openai/gpt-5.6-luna"] };
  const models = { [primary]: { alias: "Existing" } };
  const config = { agents: { defaults: structuredClone({ model, models }) } };

  const result = await applyConfig(providerId, methodId, config);
  const defaults = result.agents?.defaults;
  expect(defaults?.model).toEqual(model);
  expect(defaults?.models?.[primary]).toEqual(models[primary]);
  expect(defaults?.models?.[`${providerId}/step-3.5-flash`]).toMatchObject({
    alias: expect.any(String),
  });
  expect(result.models?.providers?.[providerId]).toBeDefined();
});
