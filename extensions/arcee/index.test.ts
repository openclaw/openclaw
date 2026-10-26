import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  applyProviderAuthConfigPatch,
  resolveAuthProfileOrder,
} from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import { applyArceeConfig, applyArceeOpenRouterConfig } from "./api.js";
import arceePlugin from "./index.js";

const apiKey = (provider: string, key: string) => ({ type: "api_key" as const, provider, key });
const unexpectedOAuth = () => {
  throw new Error("Unexpected browser auth/OAuth");
};
const modelRef = "arcee/trinity-large-thinking";
const directUrl = "https://api.arcee.ai/api/v1";
const routerUrl = "https://openrouter.ai/api/v1";
const mini = "trinity-mini";
const preview = "trinity-large-preview";
const thinking = "trinity-large-thinking";
const routerIds = [`arcee-ai/${preview}`, `arcee-ai/${thinking}`] as const;

describe.each([
  ["arcee-platform", "arceeai-api-key", "arceeaiApiKey"],
  ["openrouter", "arceeai-openrouter", "openrouterApiKey"],
])("arcee %s setup", (methodId, choiceId, optionKey) => {
  const direct = methodId === "arcee-platform";
  const credentialProvider = direct ? "arcee" : "openrouter";
  const baseUrl = direct ? directUrl : routerUrl;
  const alias = direct ? "Arcee AI" : "Arcee AI (OpenRouter)";
  const catalogIds = direct ? [mini, preview, thinking] : routerIds;
  const applyPublicConfig = direct ? applyArceeConfig : applyArceeOpenRouterConfig;
  const profileId = `${credentialProvider}:default`;

  async function registeredMethod() {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const choice = resolveProviderPluginChoice({ providers: [provider], choice: choiceId });
    const method = choice?.method;
    assert(method?.runNonInteractive, `Missing registered auth method: ${methodId}`);
    return { method, runNonInteractive: method.runNonInteractive };
  }

  async function onboard(config: OpenClawConfig) {
    const { runNonInteractive } = await registeredMethod();
    const result = await runNonInteractive({
      authChoice: choiceId,
      config,
      baseConfig: config,
      opts: {},
      runtime: createRuntimeEnv(),
      resolveApiKey: async () => ({ key: "test-arcee-key", source: "profile" }),
      toApiKeyCredential: () => null,
    });
    assert(result, "Expected successful registered onboarding");
    return result;
  }

  async function onboardInteractive(config: OpenClawConfig, key = "test-arcee-key") {
    const { method } = await registeredMethod();
    return await method.run({
      config,
      opts: { [optionKey]: key },
      env: {},
      runtime: createRuntimeEnv(),
      prompter: createTestWizardPrompter(),
      secretInputMode: "plaintext",
      isRemote: false,
      openUrl: unexpectedOAuth,
      oauth: { createVpsAwareHandlers: unexpectedOAuth },
    });
  }

  it("selects stored credentials from registered setup without crossing accounts", async () => {
    const result = await onboardInteractive({}, "selected-route-key");
    const store = {
      version: 1,
      profiles: {
        "arcee:other": apiKey("arcee", "direct-account-key"),
        "openrouter:other": apiKey("openrouter", "router-account-key"),
        ...Object.fromEntries(result.profiles.map((item) => [item.profileId, item.credential])),
      },
    };
    const cfg = applyProviderAuthConfigPatch({}, result.configPatch, result);
    const order = resolveAuthProfileOrder({ cfg, store, provider: "arcee" });
    expect(order).toEqual(expect.arrayContaining([profileId, `${credentialProvider}:other`]));
    expect(order).not.toContain(direct ? "openrouter:other" : "arcee:other");
  });

  it.each([
    { mode: undefined, expectedIds: [] },
    { mode: "replace" as const, expectedIds: catalogIds },
  ])("keeps the registered row policy in $mode mode", async ({ mode, expectedIds }) => {
    const input: OpenClawConfig = { models: { mode } };
    const nonInteractive = await onboard(input);
    const interactive = await onboardInteractive(input);
    expect(interactive.profiles).toEqual([
      { profileId, credential: apiKey(credentialProvider, "test-arcee-key") },
    ]);
    expect(interactive.defaultModel).toBe(modelRef);
    expect(nonInteractive.auth?.profiles?.[profileId]).toEqual({
      provider: credentialProvider,
      mode: "api_key",
    });
    for (const output of [nonInteractive, interactive.configPatch, await onboard(nonInteractive)]) {
      const provider = output?.models?.providers?.arcee;
      const defaults = output?.agents?.defaults;
      expect(provider).toMatchObject({
        baseUrl,
        api: "openai-completions",
        models: expectedIds.map((id) => ({ id })),
      });
      expect(defaults?.model).toEqual({ primary: modelRef });
      expect(defaults?.models?.[modelRef]).toEqual({ alias });
    }
    const rows = applyPublicConfig(input).models?.providers?.arcee?.models;
    expect(rows?.map((model) => model.id)).toEqual(catalogIds);
  });
});

it("builds the direct Arcee AI model catalog", async () => {
  clearLiveCatalogCacheForTests();
  const data = [mini, preview, thinking].map((id) => ({ id, object: "model" }));
  const fetchGuard = vi
    .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
    .mockImplementation(async ({ url }) => ({
      response: Response.json({ data }),
      finalUrl: url,
      release: async () => undefined,
    }));
  onTestFinished(() => {
    fetchGuard.mockRestore();
    clearLiveCatalogCacheForTests();
  });
  const provider = await registerSingleProviderPlugin(arceePlugin);
  const catalogProvider = await runSingleProviderCatalog(provider, {
    resolveProviderApiKey: (id?: string) =>
      id === "arcee" ? { apiKey: "test-key" } : { apiKey: undefined },
  });
  expect(catalogProvider).toMatchObject({
    models: [
      { id: preview },
      { id: thinking, compat: { supportsTools: false, supportsReasoningEffort: false } },
      { id: mini },
    ],
  });
  expect(catalogProvider.apiKey).toBe("test-key");
});

it("keeps the configured OpenRouter catalog when both credentials exist", async () => {
  const provider = await registerSingleProviderPlugin(arceePlugin);
  const result = await provider.catalog?.run({
    config: { models: { providers: { arcee: { baseUrl: routerUrl, models: [] } } } },
    env: {},
    resolveProviderApiKey: (id) => ({
      apiKey: id === "openrouter" ? "router-account-key" : "direct-account-key",
    }),
    resolveProviderAuth: () => ({
      apiKey: "router-account-key",
      mode: "api_key",
      source: "profile",
    }),
  });
  expect(result).toMatchObject({
    provider: {
      baseUrl: routerUrl,
      apiKey: "router-account-key",
      models: routerIds.map((id) => ({ id })),
    },
  });
});

it("canonicalizes stale OpenRouter /v1 config and transport metadata", async () => {
  const provider = await registerSingleProviderPlugin(arceePlugin);
  const legacy = {
    provider: "arcee",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/v1",
  };
  const normalizedConfig = provider.normalizeConfig?.({
    provider: "arcee",
    providerConfig: { api: legacy.api, baseUrl: `${legacy.baseUrl}/`, models: [] },
  } as never);
  expect(normalizedConfig?.baseUrl).toBe(routerUrl);
  const normalizedModel = provider.normalizeResolvedModel?.({
    modelId: modelRef,
    model: { ...legacy, id: thinking },
  } as never);
  expect(normalizedModel).toMatchObject({ id: routerIds[1], baseUrl: routerUrl });
  expect(provider.normalizeTransport?.(legacy as never)).toEqual({
    api: legacy.api,
    baseUrl: routerUrl,
  });
});
