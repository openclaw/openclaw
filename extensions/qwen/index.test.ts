import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderAuthContext, ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { ProviderCatalogResult } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  QWEN_BASE_URL,
  QWEN_TOKEN_PLAN_CN_BASE_URL as CN_URL,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL as GLOBAL_URL,
  QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID as LEGACY,
  QWEN_TOKEN_PLAN_PROVIDER_ID as TOKEN_PLAN,
} from "./api.js";
import qwenPlugin from "./index.js";
import { applyQwenTokenPlanConfig } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { wrapQwenProviderStream } from "./stream.js";

function requireCatalogProvider(result: ProviderCatalogResult): ModelProviderConfig {
  assert(result && "provider" in result, "single provider catalog result missing");
  return result.provider;
}

const legacyConfig = {
  api: "anthropic-messages" as const,
  baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
  apiKey: "legacy-inline-key",
  models: [{ id: "qwen3.7-plus" }],
};
const resolveCanonicalKey: ProviderCatalogContext["resolveProviderApiKey"] = (id) =>
  id === TOKEN_PLAN ? { apiKey: "canonical-key" } : { apiKey: undefined };

describe("qwen provider plugin", () => {
  let providers: Awaited<ReturnType<typeof registerProviderPlugin>>["providers"];
  const getProvider = (id = "qwen") => requireRegisteredProvider(providers, id);
  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [{ id: "qwen3.8-max" }, { id: "qwen3.8-flash" }] })),
    );
    ({ providers } = await registerProviderPlugin({
      plugin: qwenPlugin,
      id: "qwen",
      name: "Qwen Provider",
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["standard-api-key-cn", "Standard", "China", "dashscope.aliyuncs.com"],
    ["standard-api-key", "Standard", "Global/Intl", "dashscope-intl.aliyuncs.com"],
    ["api-key-cn", "Coding Plan", "China", "coding.dashscope.aliyuncs.com"],
    ["api-key", "Coding Plan", "Global/Intl", "coding-intl.dashscope.aliyuncs.com"],
  ])("preserves the %s setup flow and regional endpoint", async (id, plan, region, host) => {
    const provider = getProvider();
    const method = provider.auth.find((entry) => entry.id === id);
    assert(method, `missing Qwen auth method ${id}`);
    const { prompter, text, note } = createQueuedWizardPrompter({
      textValues: ["qwen-fixture-key"],
    });
    const result = await method.run({
      config: {},
      env: {},
      workspaceDir: "/tmp/qwen-auth-fixture",
      prompter,
      runtime: createRuntimeEnv(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: vi.fn<ProviderAuthContext["openUrl"]>(),
      oauth: {
        createVpsAwareHandlers: vi.fn<ProviderAuthContext["oauth"]["createVpsAwareHandlers"]>(),
      },
    });
    const standard = plan === "Standard";
    const endpoint = `${host}${standard ? "/compatible-mode/v1" : ""}`;
    expect(method.label).toBe(
      `${plan} API Key for ${region} (${standard ? "pay-as-you-go" : "subscription"})`,
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: standard
          ? `Enter Qwen Cloud API key (${region} standard endpoint)`
          : `Enter Qwen Cloud Coding Plan API key (${region})`,
      }),
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Endpoint: ${endpoint}`),
      `Qwen Cloud ${plan} (${region})`,
    );
    expect(result.configPatch?.models?.providers?.qwen?.baseUrl).toBe(
      `https://${endpoint}${standard ? "" : "/v1"}`,
    );
    expect(result.defaultModel).toBe("qwen/qwen3.5-plus");
    expect(result.profiles).toEqual([
      {
        profileId: "qwen:default",
        credential: { type: "api_key", provider: "qwen", key: "qwen-fixture-key" },
      },
    ]);
  });

  it("keeps Standard-only models out of Coding Plan normalized catalogs", () => {
    const normalized = getProvider().normalizeConfig?.({
      provider: "qwen",
      providerConfig: {
        baseUrl: QWEN_BASE_URL,
        models: [
          "qwen3.5-plus",
          "qwen3.6-flash",
          "qwen3.6-plus",
          "qwen3.7-max",
          "qwen3.7-plus",
          "qwen3.8-max",
          "qwen3.8-flash",
        ].map((id) => ({ id })),
      },
    } as never);

    expect(normalized?.models?.map((model) => model.id)).toEqual([
      "qwen3.5-plus",
      "qwen3.6-plus",
      "qwen3.7-plus",
    ]);
  });

  it("registers canonical and legacy Token Plan owners without catalog aliasing", async () => {
    const provider = getProvider(TOKEN_PLAN);

    expect(provider.aliases).toBeUndefined();
    expect(provider.envVars).toEqual(["QWEN_TOKEN_PLAN_API_KEY"]);
    expect(provider.auth?.map((method) => method.id)).toEqual(["api-key", "api-key-cn"]);

    const runtimeChoiceIds = provider.auth
      .map((method) => method.wizard?.choiceId)
      .filter((id): id is string => typeof id === "string")
      .toSorted();
    const manifestChoiceIds = manifest.providerAuthChoices
      .filter((choice) => choice.provider === "qwen-token-plan")
      .map((choice) => choice.choiceId)
      .toSorted();
    expect(runtimeChoiceIds).toEqual(["qwen-token-plan", "qwen-token-plan-cn"]);
    expect(manifestChoiceIds).toEqual(runtimeChoiceIds);

    const result = await provider.staticCatalog?.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({}),
    } as never);
    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider.baseUrl).toBe(GLOBAL_URL);
    expect(catalogProvider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining(["qwen3.7-plus", "qwen3.8-max", "qwen3.8-flash"]),
    );

    const legacy = getProvider(LEGACY);
    expect(legacy).toMatchObject({ auth: [], wrapStreamFn: wrapQwenProviderStream });
    for (const value of [legacy.catalog, legacy.staticCatalog, legacy.resolveThinkingProfile]) {
      expect(value).toBeUndefined();
    }
  });

  it.each([
    ["ignores legacy Anthropic configuration", { [LEGACY]: legacyConfig }, GLOBAL_URL],
    [
      "prefers canonical config after a legacy entry",
      {
        [LEGACY]: { baseUrl: legacyConfig.baseUrl, models: [{ id: "legacy-only" }] },
        [TOKEN_PLAN]: { baseUrl: CN_URL },
      },
      CN_URL,
    ],
  ])("%s", async (_name, entries, baseUrl) => {
    const provider = getProvider(TOKEN_PLAN);
    const resolveProviderApiKey = vi.fn(resolveCanonicalKey);
    const result = await provider.catalog?.run({
      config: { models: { providers: entries } },
      env: {},
      resolveProviderApiKey,
    } as never);

    const catalogProvider = requireCatalogProvider(result);
    expect(catalogProvider).toMatchObject({
      api: "openai-completions",
      apiKey: "canonical-key",
      baseUrl,
    });
    const modelIds = catalogProvider.models.map((model) => model.id);
    expect(modelIds).toEqual(expect.arrayContaining(["qwen3.8-max", "qwen3.8-flash"]));
    expect(modelIds).not.toContain("legacy-only");
    expect(resolveProviderApiKey).toHaveBeenCalledTimes(1);
    expect(resolveProviderApiKey).toHaveBeenCalledWith(TOKEN_PLAN);
  });

  it("preserves thinking controls for catalog and uncataloged Token Plan refs", () => {
    const profile = (modelId: string, ownerId = TOKEN_PLAN) =>
      getProvider(ownerId).resolveThinkingProfile?.({ modelId } as never);
    const qwen38 = {
      levels: ["off", "low", "medium", "xhigh"].map((id) => ({ id })),
      defaultLevel: "xhigh",
    };
    for (const ownerId of ["qwen", TOKEN_PLAN]) {
      const actual = ["qwen3.8-max", "qwen3.8-flash"].map((id) => profile(id, ownerId));
      expect(actual).toEqual([qwen38, qwen38]);
    }
    const expected = {
      levels: [{ id: "low", label: "on" }],
      defaultLevel: "low",
      preserveWhenCatalogReasoningFalse: true,
    };

    expect(profile("kimi-k2.7-code")).toEqual(expected);
    expect(profile("MiniMax-M2.5")).toEqual(expected);
    expect(profile("qwen3.7-plus")).toBeUndefined();
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
    const full = { levels: [...levels, "max"].map((id) => ({ id })), defaultLevel: "high" };
    const noMax = { levels: levels.map((id) => ({ id })), defaultLevel: "high" };
    const actual = ["deepseek-v4-pro", "glm-5.2", "glm-5.1", "glm-5"].map((id) => profile(id));
    expect(actual).toEqual([full, full, noMax, noMax]);
  });

  it("switches Token Plan regions without replacing custom catalog rows", () => {
    const global = applyQwenTokenPlanConfig({ models: { mode: "replace" } }, "global");
    const globalProvider = global.models?.providers?.[TOKEN_PLAN];
    assert(globalProvider, "Token Plan provider missing after onboarding");
    const qwenModel = globalProvider.models.find((model) => model.id === "qwen3.7-plus");
    assert(qwenModel, "Qwen3.7-Plus missing from Token Plan catalog");
    qwenModel.name = "Custom Qwen3.7-Plus";
    globalProvider.models.push({ ...qwenModel, id: "custom-model" });
    const cnFromGlobal = applyQwenTokenPlanConfig(
      { ...global, models: { ...global.models, mode: "merge" } },
      "cn",
    );
    const globalAgain = applyQwenTokenPlanConfig(cnFromGlobal, "global");

    const tokenPlanProvider = (config: OpenClawConfig) => config.models?.providers?.[TOKEN_PLAN];
    const qwenRow = (config: OpenClawConfig) =>
      tokenPlanProvider(config)?.models?.find((model) => model.id === "qwen3.7-plus");
    expect(
      [global, cnFromGlobal, globalAgain].map((config) => qwenRow(config)?.contextWindow),
    ).toEqual([1_000_000, 1_000_000, 1_000_000]);
    expect(tokenPlanProvider(cnFromGlobal)?.baseUrl).toBe(CN_URL);
    expect(tokenPlanProvider(globalAgain)?.baseUrl).toBe(GLOBAL_URL);
    expect(qwenRow(globalAgain)?.name).toBe("Custom Qwen3.7-Plus");
    const modelIds = tokenPlanProvider(globalAgain)?.models?.map((model) => model.id) ?? [];
    expect(modelIds).toContain("custom-model");
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });
});
