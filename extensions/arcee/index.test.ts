import {
  createRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  applyProviderAuthConfigPatch,
  resolveAuthProfileOrder,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelDefinitionConfig, OpenClawConfig } from "openclaw/plugin-sdk/provider-onboard";
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
  const collisionId = direct ? thinking : routerIds[1];
  const catalogAdditions = catalogIds.slice(0, -1);

  async function registeredMethod() {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const choice = resolveProviderPluginChoice({ providers: [provider], choice: choiceId });
    expect(choice).toMatchObject({ provider: { id: "arcee" }, method: { id: methodId } });
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
    const store: AuthProfileStore = {
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
      expect({ model: defaults?.model, alias: defaults?.models?.[modelRef] }).toEqual({
        model: { primary: modelRef },
        alias: { alias },
      });
    }
    expect(input).toEqual({ models: { mode } });
  });

  it.each([
    { mode: "merge" as const, addedIds: [] },
    { mode: "replace" as const, addedIds: catalogAdditions },
  ])("preserves authored rows and aliases in $mode mode", async ({ mode, addedIds }) => {
    const collision: ModelDefinitionConfig = {
      id: collisionId,
      name: "Authored collision",
      reasoning: false,
      input: ["text"],
      contextWindow: 12345,
      maxTokens: 2345,
      cost: { input: 7, output: 9, cacheRead: 1, cacheWrite: 2 },
    };
    const authoredOnly = { ...collision, id: "operator-only", name: "Authored only" };
    const input: OpenClawConfig = {
      auth: { profiles: { "other:default": { provider: "other", mode: "api_key" } } },
      agents: {
        defaults: {
          model: { primary: "arcee/operator-only", fallbacks: ["arcee/fallback"] },
          models: { [modelRef]: { alias: "Authored alias", params: { temperature: 0.2 } } },
        },
      },
      models: {
        mode,
        providers: {
          arcee: { baseUrl, models: [collision, authoredOnly] },
          other: { baseUrl: "https://other.invalid/v1", models: [] },
        },
      },
    };
    const before = structuredClone(input);
    function expectPreserved(output: OpenClawConfig, additions: string[], primary: string) {
      const models = output.models?.providers?.arcee?.models;
      expect(models?.slice(0, 2)).toEqual([collision, authoredOnly]);
      const expectedIds = [collisionId, "operator-only", ...additions];
      expect(models?.map((model) => model.id)).toEqual(expectedIds);
      expect(output.models?.providers?.other).toEqual(input.models?.providers?.other);
      expect(output.auth?.profiles?.["other:default"]).toEqual(
        input.auth?.profiles?.["other:default"],
      );
      expect(output.agents?.defaults).toEqual({
        ...input.agents?.defaults,
        model: { primary, fallbacks: ["arcee/fallback"] },
      });
    }
    const output = await onboard(input);
    expectPreserved(output, addedIds, modelRef);
    expect(await onboard(output)).toEqual(output);
    expect(input).toEqual(before);
    expectPreserved(applyPublicConfig(input), catalogAdditions, "arcee/operator-only");
  });
});

it("builds the direct Arcee AI model catalog", async () => {
  clearLiveCatalogCacheForTests();
  const release = vi.fn(async () => undefined);
  const data = [mini, preview, thinking].map((id) => ({ id, object: "model" }));
  const fetchGuard = vi
    .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
    .mockImplementation(async ({ url }) => ({
      response: Response.json({ data }),
      finalUrl: url,
      release,
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
    api: "openai-completions",
    baseUrl: directUrl,
    models: [
      { id: preview },
      { id: thinking, compat: { supportsTools: false, supportsReasoningEffort: false } },
      { id: mini },
    ],
  });
  expect(fetchGuard).toHaveBeenCalledOnce();
  const request = fetchGuard.mock.calls[0]?.[0];
  expect({
    url: request?.url,
    init: { ...request?.init, headers: Object.fromEntries(new Headers(request?.init?.headers)) },
  }).toEqual({
    url: "https://api.arcee.ai/api/v1/models",
    init: { headers: { accept: "application/json", authorization: "Bearer test-key" } },
  });
  expect(release).toHaveBeenCalledOnce();
});

it("keeps the configured OpenRouter catalog when both credentials exist", async () => {
  const provider = await registerSingleProviderPlugin(arceePlugin);
  const result = await provider.catalog?.run({
    config: {
      models: { providers: { arcee: { baseUrl: routerUrl, models: [] } } },
    },
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
  const canonical = { api: legacy.api, baseUrl: routerUrl };
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
  expect(provider.normalizeTransport?.(legacy as never)).toEqual(canonical);
});
