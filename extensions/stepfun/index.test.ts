import type { Context, Model } from "openclaw/plugin-sdk/llm";
import * as plugins from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { assert, describe, expect, it } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import stepfunPlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import * as catalog from "./provider-catalog.js";

function registerStepFun() {
  return plugins.registerProviderPlugin({ plugin: stepfunPlugin, id: "stepfun", name: "StepFun" });
}

describe.each([
  ["stepfun", "standard-api-key-intl", undefined, ["step-3.7-flash", "step-3.5-flash"]],
  [
    "stepfun-plan",
    "plan-api-key-cn",
    "merge",
    ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"],
  ],
] as const)("%s setup", (providerId, methodId, mode, rows) => {
  async function apply(config: OpenClawConfig) {
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

  it("leaves ordinary rows runtime-owned and retains aliases", async () => {
    const config = await apply({ models: { mode } });

    expect(config.models?.providers?.[providerId]?.models).toEqual([]);
    expect(config.agents?.defaults?.models?.[`${providerId}/step-3.7-flash`]).toEqual({});
    expect(config.agents?.defaults?.models?.[`${providerId}/step-3.5-flash`]?.alias).toBeDefined();
    expect(await apply(config)).toEqual(config);
  });

  it("retains the shipped replace catalog", async () => {
    const config = await apply({ models: { mode: "replace" } });
    expect(config.models?.providers?.[providerId]?.models.map((model) => model.id)).toEqual(rows);
  });
});

it("adds Step 3.7 Flash without changing existing defaults", () => {
  const standard = catalog.buildStepFunProvider();
  const plan = catalog.buildStepFunPlanProvider();
  const standardModel = standard.models?.find((model) => model.id === "step-3.7-flash");
  const planModel = plan.models?.find((model) => model.id === "step-3.7-flash");
  assert(standardModel, "StepFun Standard catalog did not provide Step 3.7 Flash");

  expect(catalog.STEPFUN_DEFAULT_MODEL_REF).toBe("stepfun/step-3.5-flash");
  expect(catalog.STEPFUN_PLAN_DEFAULT_MODEL_REF).toBe("stepfun-plan/step-3.5-flash");
  const standard35 = standard.models?.find((model) => model.id === "step-3.5-flash");
  expect(standard35?.compat?.supportsReasoningEffort).not.toBe(true);
  expect(standard35?.cost).toEqual({ input: 0.1, output: 0.3, cacheRead: 0.02, cacheWrite: 0 });
  for (const [model, cost] of [
    [standardModel, { input: 0.2, output: 1.15, cacheRead: 0.04, cacheWrite: 0 }],
    [planModel, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
  ]) {
    expect(model).toMatchObject({
      cost,
      reasoning: true,
      input: ["text", "image"],
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "high", max: "high" },
      contextWindow: 262144,
      maxTokens: 262144,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        supportsReasoningEffort: true,
        supportsStrictMode: false,
        supportedReasoningEfforts: ["low", "medium", "high"],
        maxTokensField: "max_tokens",
        reasoningEffortMap: { off: "low", medium: "medium", max: "high" },
      },
    });
  }

  const transportModel = {
    ...standardModel,
    provider: "stepfun",
    api: "openai-completions",
    baseUrl: standard.baseUrl,
  } as Model<"openai-completions">;
  const context = {
    systemPrompt: "system",
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  } as Context;
  const payloadFor = (reasoning: string | undefined, maxTokens?: number) =>
    buildOpenAICompletionsParams(transportModel, context, { reasoning, maxTokens } as never);
  const lowPayload = payloadFor(standardModel.thinkingLevelMap?.off ?? undefined, 128);
  expect(lowPayload).toMatchObject({ reasoning_effort: "low", max_tokens: 128 });
  expect(lowPayload).not.toHaveProperty("max_completion_tokens");
  expect(lowPayload).not.toHaveProperty("store");
  expect(lowPayload).not.toHaveProperty("stream_options");
  expect(lowPayload.messages).toContainEqual(
    expect.objectContaining({ role: "system", content: "system" }),
  );
  expect(lowPayload.messages).not.toContainEqual(expect.objectContaining({ role: "developer" }));
  expect(payloadFor("high").reasoning_effort).toBe("high");
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
  const { providers } = await registerStepFun();
  const provider = plugins.requireRegisteredProvider(providers, providerId);
  const method = provider.auth.find((entry) => entry.id === methodId);
  assert(method?.runNonInteractive && method.wizard?.choiceId, `Missing auth method ${methodId}`);

  const primary = "anthropic/claude-sonnet-4-6";
  const model = { primary, fallbacks: ["openai/gpt-5.6-luna"] };
  const models = { [primary]: { alias: "Existing" } };
  const config = { agents: { defaults: structuredClone({ model, models }) } };

  const result = await method.runNonInteractive({
    authChoice: method.wizard.choiceId,
    config,
    baseConfig: config,
    opts: {},
    runtime: createRuntimeSpies(),
    resolveApiKey: async () => ({ key: "fixture-value", source: "profile" as const }),
    toApiKeyCredential: () => null,
  });

  const defaults = result?.agents?.defaults;
  expect(defaults?.model).toEqual(model);
  expect(defaults?.models?.[primary]).toEqual(models[primary]);
  expect(defaults?.models?.[`${providerId}/step-3.5-flash`]).toMatchObject({
    alias: expect.any(String),
  });
  expect(result?.models?.providers?.[providerId]).toBeDefined();
});
