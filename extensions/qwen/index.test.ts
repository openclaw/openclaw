import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderAuthContext, ProviderCatalogContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createQueuedWizardPrompter,
  createRuntimeEnv,
  registerProviderPlugin,
  requireRegisteredProvider,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import {
  QWEN_BASE_URL,
  QWEN_TOKEN_PLAN_CN_BASE_URL as CN_URL,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL as GLOBAL_URL,
  QWEN_TOKEN_PLAN_LEGACY_PROVIDER_ID as LEGACY,
  QWEN_TOKEN_PLAN_PROVIDER_ID as TOKEN_PLAN,
} from "./api.js";
import qwenPlugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { wrapQwenProviderStream } from "./stream.js";

const legacyConfig = {
  api: "anthropic-messages" as const,
  baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic",
  apiKey: "legacy-inline-key",
  models: [{ id: "legacy-only" }],
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

  function authenticate(config: OpenClawConfig, providerId: string, methodId: string) {
    const method = getProvider(providerId).auth.find((entry) => entry.id === methodId);
    assert(method, `missing Qwen auth method ${methodId}`);
    const { prompter } = createQueuedWizardPrompter({ textValues: ["qwen-fixture-key"] });
    return method.run({
      config,
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
  }

  async function applySetup(config: OpenClawConfig, providerId: string, methodId: string) {
    const { configPatch } = await authenticate(config, providerId, methodId);
    assert(configPatch, "Qwen auth config patch missing");
    return applyProviderAuthConfigPatch(config, configPatch);
  }

  it("keeps Standard-only models out of Coding Plan normalized catalogs", () => {
    const normalized = getProvider().normalizeConfig?.({
      provider: "qwen",
      providerConfig: {
        baseUrl: QWEN_BASE_URL,
        models: ["qwen3.5-plus", "qwen3.8-max"].map((id) => ({ id })),
      },
    } as never);

    expect(normalized?.models?.map((model) => model.id)).toEqual(["qwen3.5-plus"]);
  });
  it("registers canonical and legacy Token Plan owners without catalog aliasing", async () => {
    const provider = getProvider(TOKEN_PLAN);
    expect(provider.aliases).toBeUndefined();
    expect(provider.envVars).toEqual(["QWEN_TOKEN_PLAN_API_KEY"]);

    const runtimeChoiceIds = provider.auth
      .map(({ wizard }) => {
        assert(wizard?.choiceId, "Qwen auth method missing wizard choice");
        return wizard.choiceId;
      })
      .toSorted();
    expect(runtimeChoiceIds).toEqual(["qwen-token-plan", "qwen-token-plan-cn"]);
    expect(
      manifest.providerAuthChoices
        .filter((choice) => choice.provider === TOKEN_PLAN)
        .map((choice) => choice.choiceId)
        .toSorted(),
    ).toEqual(runtimeChoiceIds);

    const catalogProvider = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
    expect(catalogProvider.baseUrl).toBe(GLOBAL_URL);
    expect(catalogProvider.models.map((model) => model.id)).toContain("qwen3.7-plus");

    const legacy = getProvider(LEGACY);
    expect(legacy).toMatchObject({ auth: [], wrapStreamFn: wrapQwenProviderStream });
    expect([legacy.catalog, legacy.staticCatalog, legacy.resolveThinkingProfile]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it.each([
    ["ignores legacy Anthropic configuration", { [LEGACY]: legacyConfig }, GLOBAL_URL],
    [
      "prefers canonical config after a legacy entry",
      { [LEGACY]: legacyConfig, [TOKEN_PLAN]: { baseUrl: CN_URL } },
      CN_URL,
    ],
  ])("%s", async (_name, entries, baseUrl) => {
    const resolveProviderApiKey = vi.fn(resolveCanonicalKey);
    const result = await getProvider(TOKEN_PLAN).catalog?.run({
      config: { models: { providers: entries } },
      env: {},
      resolveProviderApiKey,
    } as never);

    assert(result && "provider" in result, "single provider catalog result missing");
    const catalogProvider = result.provider;
    expect(catalogProvider).toMatchObject({
      api: "openai-completions",
      apiKey: "canonical-key",
      baseUrl,
    });
    expect(catalogProvider.models.map((model) => model.id)).not.toContain("legacy-only");
    expect(resolveProviderApiKey).toHaveBeenCalledWith(TOKEN_PLAN);
  });

  it("preserves thinking controls for catalog and uncataloged Token Plan refs", () => {
    const profile = (modelId: string, ownerId = TOKEN_PLAN) =>
      getProvider(ownerId).resolveThinkingProfile?.({ modelId } as never);
    for (const ownerId of ["qwen", TOKEN_PLAN]) {
      expect(profile("qwen3.8-max", ownerId)).toEqual({
        levels: ["off", "low", "medium", "xhigh"].map((id) => ({ id })),
        defaultLevel: "xhigh",
      });
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

  it("switches Token Plan regions without replacing custom catalog rows", async () => {
    const global = await applySetup({ models: { mode: "replace" } }, TOKEN_PLAN, "api-key");
    const globalProvider = global.models?.providers?.[TOKEN_PLAN];
    assert(globalProvider, "Token Plan provider missing after onboarding");
    const qwenModel = globalProvider.models.find((model) => model.id === "qwen3.7-plus");
    assert(qwenModel, "Qwen3.7-Plus missing from Token Plan catalog");
    qwenModel.name = "Custom Qwen3.7-Plus";
    globalProvider.models.push({ ...qwenModel, id: "custom-model" });
    const cnFromGlobal = await applySetup(
      { ...global, models: { ...global.models, mode: "merge" } },
      TOKEN_PLAN,
      "api-key-cn",
    );
    const globalAgain = await applySetup(cnFromGlobal, TOKEN_PLAN, "api-key");

    const catalogs = [global, cnFromGlobal, globalAgain].map(
      (config) => config.models?.providers?.[TOKEN_PLAN],
    );
    const rows = catalogs.map((provider) =>
      provider?.models.find((model) => model.id === "qwen3.7-plus"),
    );
    expect(rows.map((row) => row?.contextWindow)).toEqual([1_000_000, 1_000_000, 1_000_000]);
    expect(catalogs.map((provider) => provider?.baseUrl)).toEqual([GLOBAL_URL, CN_URL, GLOBAL_URL]);
    expect(rows[2]?.name).toBe("Custom Qwen3.7-Plus");
    const modelIds = catalogs[2]?.models.map((model) => model.id) ?? [];
    expect(modelIds).toContain("custom-model");
    expect(new Set(modelIds).size).toBe(modelIds.length);
  });

  it.each([
    ["qwen", "api-key", undefined, "coding-intl.dashscope.aliyuncs.com/v1"],
    ["qwen", "api-key-cn", "merge", "coding.dashscope.aliyuncs.com/v1"],
    ["qwen", "standard-api-key", undefined, "dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["qwen", "standard-api-key-cn", "merge", "dashscope.aliyuncs.com/compatible-mode/v1"],
    [TOKEN_PLAN, "api-key", undefined, GLOBAL_URL.slice(8)],
    [TOKEN_PLAN, "api-key-cn", "merge", CN_URL.slice(8)],
  ] as const)(
    "%s %s preserves credentials, endpoint, runtime-owned rows and aliases",
    async (provider, method, mode, endpoint) => {
      const authored = { alias: "Authored", params: { temperature: 0.2 } };
      const input: OpenClawConfig = {
        models: { mode },
        agents: { defaults: { models: { "qwen/qwen3.5-plus": authored } } },
      };
      const result = await authenticate(input, provider, method);
      expect(result.defaultModel).toBe(
        `${provider}/${provider === "qwen" ? "qwen3.5-plus" : "qwen3.7-plus"}`,
      );
      expect(result.profiles).toEqual([
        {
          profileId: `${provider}:default`,
          credential: { type: "api_key", provider, key: "qwen-fixture-key" },
        },
      ]);
      assert(result.configPatch, "Qwen auth config patch missing");
      const config = applyProviderAuthConfigPatch(input, result.configPatch);
      expect(config.models?.providers?.[provider]).toMatchObject({
        baseUrl: `https://${endpoint}`,
        models: [],
      });
      expect(config.agents?.defaults?.models?.["qwen/qwen3.5-plus"]).toEqual(authored);
      expect(config.agents?.defaults?.models?.[`${provider}/qwen3.7-plus`]).toBeDefined();
      if (provider === "qwen") {
        expect(config.agents?.defaults?.models?.["modelstudio/qwen3.7-plus"]).toBeDefined();
      }
      expect(await applySetup(config, provider, method)).toEqual(config);
    },
  );
  it.each([
    { name: "coding", provider: "qwen", method: "api-key", rows: 10 },
    { name: "standard", provider: "qwen", method: "standard-api-key", rows: 14 },
    { name: "Token Plan", provider: TOKEN_PLAN, method: "api-key", rows: 7 },
  ])("retains the shipped $name replace catalog", async ({ provider, method, rows }) => {
    const config = await applySetup({ models: { mode: "replace" } }, provider, method);
    expect(config.models?.providers?.[provider]?.models).toHaveLength(rows);
  });
});
