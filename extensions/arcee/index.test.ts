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
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import { applyArceeConfig, applyArceeOpenRouterConfig } from "./api.js";
import arceePlugin from "./index.js";

const apiKey = (provider: string, key: string) => ({ type: "api_key" as const, provider, key });
const unexpectedOAuth = () => {
  throw new Error("Unexpected browser auth/OAuth");
};

describe("arcee provider plugin", () => {
  describe.each([
    {
      methodId: "arcee-platform",
      choiceId: "arceeai-api-key",
      optionKey: "arceeaiApiKey",
      credentialProvider: "arcee",
      baseUrl: "https://api.arcee.ai/api/v1",
      alias: "Arcee AI",
      catalogIds: ["trinity-mini", "trinity-large-preview", "trinity-large-thinking"],
      collisionId: "trinity-large-thinking",
      addedIds: ["trinity-mini", "trinity-large-preview"],
      applyPublicConfig: applyArceeConfig,
    },
    {
      methodId: "openrouter",
      choiceId: "arceeai-openrouter",
      optionKey: "openrouterApiKey",
      credentialProvider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      alias: "Arcee AI (OpenRouter)",
      catalogIds: ["arcee-ai/trinity-large-preview", "arcee-ai/trinity-large-thinking"],
      collisionId: "arcee-ai/trinity-large-thinking",
      addedIds: ["arcee-ai/trinity-large-preview"],
      applyPublicConfig: applyArceeOpenRouterConfig,
    },
  ])("$methodId setup", (route) => {
    const modelRef = "arcee/trinity-large-thinking";
    const profileId = `${route.credentialProvider}:default`;

    async function registeredMethod() {
      const provider = await registerSingleProviderPlugin(arceePlugin);
      const choice = resolveProviderPluginChoice({ providers: [provider], choice: route.choiceId });
      expect(choice?.provider.id).toBe("arcee");
      expect(choice?.method.id).toBe(route.methodId);
      const method = choice?.method;
      if (!method?.runNonInteractive) {
        throw new Error(`Missing registered auth method: ${route.methodId}`);
      }
      return { method, runNonInteractive: method.runNonInteractive };
    }

    async function onboard(config: OpenClawConfig) {
      const { runNonInteractive } = await registeredMethod();
      const result = await runNonInteractive({
        authChoice: route.choiceId,
        config,
        baseConfig: config,
        opts: {},
        runtime: createRuntimeEnv(),
        resolveApiKey: async () => ({ key: "test-arcee-key", source: "profile" }),
        toApiKeyCredential: () => null,
      });
      if (!result) {
        throw new Error("Expected successful registered onboarding");
      }
      return result;
    }

    async function onboardInteractive(config: OpenClawConfig, key = "test-arcee-key") {
      const { method } = await registeredMethod();
      return await method.run({
        config,
        opts: { [route.optionKey]: key },
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
          ...Object.fromEntries(
            result.profiles.map((profile) => [profile.profileId, profile.credential]),
          ),
        },
      };
      const cfg = applyProviderAuthConfigPatch({}, result.configPatch, result);
      const order = resolveAuthProfileOrder({ cfg, store, provider: "arcee" });
      expect(order).toContain(profileId);
      expect(order).toContain(`${route.credentialProvider}:other`);
      expect(order).not.toContain(
        route.credentialProvider === "arcee" ? "openrouter:other" : "arcee:other",
      );
      expect(result.defaultModel).toBe(modelRef);
    });

    it.each([
      { mode: undefined, expectedIds: [] },
      { mode: "replace" as const, expectedIds: route.catalogIds },
    ])("keeps the registered row policy in $mode mode", async ({ mode, expectedIds }) => {
      const input: OpenClawConfig = { models: { mode } };
      const nonInteractive = await onboard(input);
      const interactive = await onboardInteractive(input);

      expect(interactive.profiles).toEqual([
        { profileId, credential: apiKey(route.credentialProvider, "test-arcee-key") },
      ]);
      expect(interactive.defaultModel).toBe(modelRef);
      expect(nonInteractive.auth?.profiles?.[profileId]).toEqual({
        provider: route.credentialProvider,
        mode: "api_key",
      });
      for (const output of [
        nonInteractive,
        interactive.configPatch,
        await onboard(nonInteractive),
      ]) {
        expect(output?.models?.providers?.arcee).toMatchObject({
          baseUrl: route.baseUrl,
          api: "openai-completions",
        });
        expect(output?.models?.providers?.arcee?.models?.map((model) => model.id)).toEqual(
          expectedIds,
        );
        expect(output?.agents?.defaults?.model).toEqual({ primary: modelRef });
        expect(output?.agents?.defaults?.models?.[modelRef]).toEqual({ alias: route.alias });
      }
      expect(input).toEqual({ models: { mode } });
    });

    it.each([
      { mode: "merge" as const, addedIds: [] },
      { mode: "replace" as const, addedIds: route.addedIds },
    ])("preserves authored rows and aliases in $mode mode", async ({ mode, addedIds }) => {
      const collision: ModelDefinitionConfig = {
        id: route.collisionId,
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
            arcee: { baseUrl: route.baseUrl, models: [collision, authoredOnly] },
            other: { baseUrl: "https://other.invalid/v1", models: [] },
          },
        },
      };
      const before = structuredClone(input);
      const authoredProfile = input.auth?.profiles?.["other:default"];
      const authoredAlias = input.agents?.defaults?.models?.[modelRef];
      function expectPreserved(output: OpenClawConfig, additions: string[], primary: string) {
        const models = output.models?.providers?.arcee?.models;
        expect(models?.slice(0, 2)).toEqual([collision, authoredOnly]);
        const expectedIds = [route.collisionId, "operator-only", ...additions];
        expect(models?.map((model) => model.id)).toEqual(expectedIds);
        expect(output.models?.providers?.other).toEqual(input.models?.providers?.other);
        expect(output.auth?.profiles?.["other:default"]).toEqual(authoredProfile);
        expect(output.agents?.defaults?.models?.[modelRef]).toEqual(authoredAlias);
        expect(output.agents?.defaults?.model).toEqual({ primary, fallbacks: ["arcee/fallback"] });
      }
      const output = await onboard(input);
      expectPreserved(output, addedIds, modelRef);
      expect(await onboard(output)).toEqual(output);
      expect(input).toEqual(before);
      expectPreserved(route.applyPublicConfig(input), route.addedIds, "arcee/operator-only");
    });
  });

  it("builds the direct Arcee AI model catalog", async () => {
    clearLiveCatalogCacheForTests();
    const release = vi.fn(async () => undefined);
    const fetchGuard = vi
      .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
      .mockImplementation(async ({ url }) => ({
        response: Response.json({
          data: ["trinity-mini", "trinity-large-preview", "trinity-large-thinking"].map((id) => ({
            id,
            object: "model",
          })),
        }),
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
      baseUrl: "https://api.arcee.ai/api/v1",
    });
    expect(catalogProvider.models?.map((model) => model.id)).toEqual([
      "trinity-large-preview",
      "trinity-large-thinking",
      "trinity-mini",
    ]);
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
    const thinkingCompat = catalogProvider.models?.find(
      (model) => model.id === "trinity-large-thinking",
    )?.compat;
    expect(thinkingCompat).toMatchObject({ supportsTools: false, supportsReasoningEffort: false });
  });

  it("keeps the configured OpenRouter catalog when both credentials exist", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const result = await provider.catalog?.run({
      config: {
        models: { providers: { arcee: { baseUrl: "https://openrouter.ai/api/v1", models: [] } } },
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
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "router-account-key",
        models: [
          { id: "arcee-ai/trinity-large-preview" },
          { id: "arcee-ai/trinity-large-thinking" },
        ],
      },
    });
  });

  it("canonicalizes stale OpenRouter /v1 config and transport metadata", async () => {
    const provider = await registerSingleProviderPlugin(arceePlugin);
    const transport = {
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/v1",
    };
    const canonicalTransport = { api: transport.api, baseUrl: "https://openrouter.ai/api/v1" };
    const normalizedConfig = provider.normalizeConfig?.({
      provider: "arcee",
      providerConfig: { ...transport, baseUrl: `${transport.baseUrl}/`, models: [] },
    } as never);
    expect(normalizedConfig?.baseUrl).toBe(canonicalTransport.baseUrl);
    const normalizedModel = provider.normalizeResolvedModel?.({
      modelId: "arcee/trinity-large-thinking",
      model: {
        ...transport,
        provider: "arcee",
        id: "trinity-large-thinking",
        name: "Trinity Large Thinking",
      },
    } as never);
    expect(normalizedModel).toMatchObject({
      id: "arcee-ai/trinity-large-thinking",
      baseUrl: canonicalTransport.baseUrl,
    });
    expect(provider.normalizeTransport?.({ ...transport, provider: "arcee" } as never)).toEqual(
      canonicalTransport,
    );
  });
});
