// Litellm tests cover index plugin behavior.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
  registerProviderPlugin,
  requireRegisteredProvider,
  runProviderCatalog,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const LITELLM_DEFAULT_MODEL = {
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  expect(provider?.id).toBe("litellm");
  return provider;
}

describe("litellm plugin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearLiveCatalogCacheForTests();
  });

  it.each([
    { authMode: "non-interactive", modelsMode: "merge" },
    { authMode: "interactive", modelsMode: "merge" },
    { authMode: "non-interactive", modelsMode: "replace" },
    { authMode: "interactive", modelsMode: "replace" },
  ] as const)(
    "preserves an explicit proxy's authored models through registered $authMode auth in $modelsMode mode",
    async ({ authMode, modelsMode }) => {
      const auth = registerProvider()?.auth?.[0];
      const config = {
        models: {
          mode: modelsMode,
          providers: {
            litellm: {
              baseUrl: "https://litellm.example/v1",
              api: "anthropic-messages",
              apiKey: "  old-key  ",
              models: [
                {
                  id: "custom-model",
                  name: "Custom",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1000,
                  maxTokens: 100,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig;
      let result: OpenClawConfig | null | undefined;
      if (authMode === "non-interactive") {
        result = await auth?.runNonInteractive?.({
          authChoice: "litellm-api-key",
          config,
          baseConfig: config,
          opts: { customBaseUrl: "https://litellm.example/v1/" },
          runtime: createRuntimeSpies(),
          resolveApiKey: async () => ({ key: "old-key", source: "profile" }),
          toApiKeyCredential: () => null,
        });
      } else {
        const interactive = await auth?.run({
          config,
          opts: { litellmApiKey: "old-key" },
          env: {},
          runtime: createRuntimeSpies(),
          prompter: createTestWizardPrompter(),
          secretInputMode: "plaintext",
          isRemote: false,
          openUrl: async () => {
            throw new Error("Unexpected browser auth");
          },
          oauth: {
            createVpsAwareHandlers: () => {
              throw new Error("Unexpected OAuth");
            },
          },
        });
        expect(interactive?.profiles).toEqual([
          {
            profileId: "litellm:default",
            credential: { type: "api_key", provider: "litellm", key: "old-key" },
          },
        ]);
        result = interactive?.configPatch;
      }

      expect(result?.models?.mode).toBe(modelsMode);
      expect(result?.models?.providers?.litellm).toEqual({
        baseUrl: "https://litellm.example/v1",
        api: "openai-completions",
        apiKey: "old-key",
        models: [
          ...config.models.providers.litellm.models,
          ...(modelsMode === "replace" ? [LITELLM_DEFAULT_MODEL] : []),
        ],
      });
    },
  );

  it.each([
    {
      name: "default proxy base URL",
      baseUrl: undefined,
      endpoint: "http://localhost:4000/v1/models",
    },
    {
      name: "unversioned explicit base URL",
      baseUrl: "https://litellm.example",
      endpoint: "https://litellm.example/v1/models",
    },
    {
      name: "versioned explicit base URL",
      baseUrl: "https://litellm.example/v1",
      endpoint: "https://litellm.example/v1/models",
    },
    {
      name: "versioned explicit base URL with a path prefix and trailing slashes",
      baseUrl: " https://proxy.example/litellm/v1// ",
      endpoint: "https://proxy.example/litellm/v1/models",
    },
    {
      name: "versioned explicit base URL under a mixed-case provider key",
      providerKey: "LiteLLM",
      baseUrl: "https://litellm.example/v1",
      endpoint: "https://litellm.example/v1/models",
    },
  ])("discovers models from the $name", async ({ providerKey = "litellm", baseUrl, endpoint }) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      input === endpoint
        ? Response.json({ object: "list", data: [{ id: "proxy-model", object: "model" }] })
        : new Response("Not Found", { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { providers } = await registerProviderPlugin({
      plugin,
      id: "litellm",
      name: "LiteLLM Provider",
    });

    const result = await runProviderCatalog({
      provider: requireRegisteredProvider(providers, "litellm"),
      config: baseUrl ? { models: { providers: { [providerKey]: { baseUrl, models: [] } } } } : {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "LITELLM_API_KEY", discoveryApiKey: "sk-test" }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });

    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([endpoint]);
    expect(result).toMatchObject({
      provider: { models: [expect.objectContaining({ id: "proxy-model" })] },
      outcomes: [{ provider: "litellm", status: "ready" }],
    });
  });

  it.each([
    {
      modelsMode: undefined,
      baseUrl: "https://litellm.example/v1/",
      expectedBaseUrl: "https://litellm.example/v1",
      expectedModels: [],
    },
    {
      modelsMode: undefined,
      baseUrl: undefined,
      expectedBaseUrl: "http://localhost:4000",
      expectedModels: [LITELLM_DEFAULT_MODEL],
    },
    {
      modelsMode: "replace" as const,
      baseUrl: "https://litellm.example/v1/",
      expectedBaseUrl: "https://litellm.example/v1",
      expectedModels: [LITELLM_DEFAULT_MODEL],
    },
  ])(
    "configures proxy URL $baseUrl in $modelsMode mode",
    async ({ modelsMode, baseUrl, expectedBaseUrl, expectedModels }) => {
      const provider = registerProvider();
      const auth = provider?.auth?.[0];
      const config = (modelsMode ? { models: { mode: modelsMode } } : {}) satisfies OpenClawConfig;
      const agentDir = mkdtempSync(join(tmpdir(), "openclaw-litellm-auth-"));
      const resolveApiKey = vi.fn(async () => ({
        key: "litellm-test-key",
        source: "flag" as const,
      }));
      const toApiKeyCredential = vi.fn(({ provider: providerId, resolved }) => ({
        type: "api_key" as const,
        provider: providerId,
        key: resolved.key,
      }));

      try {
        const result = await auth?.runNonInteractive?.({
          authChoice: "litellm-api-key",
          config,
          baseConfig: config,
          opts: {
            litellmApiKey: "litellm-test-key",
            customBaseUrl: baseUrl,
          },
          runtime: createRuntimeSpies(),
          agentDir,
          resolveApiKey,
          toApiKeyCredential,
        });

        expect(result).toStrictEqual({
          auth: {
            profiles: {
              "litellm:default": {
                provider: "litellm",
                mode: "api_key",
              },
            },
          },
          agents: {
            defaults: {
              models: {
                "litellm/claude-opus-4-6": {
                  alias: "LiteLLM",
                },
              },
              model: {
                primary: "litellm/claude-opus-4-6",
              },
            },
          },
          models: {
            mode: modelsMode ?? "merge",
            providers: {
              litellm: {
                baseUrl: expectedBaseUrl,
                api: "openai-completions",
                models: expectedModels,
              },
            },
          },
        });
        expect(resolveApiKey).toHaveBeenCalledWith({
          provider: "litellm",
          flagValue: "litellm-test-key",
          flagName: "--litellm-api-key",
          envVar: "LITELLM_API_KEY",
        });
        expect(toApiKeyCredential).toHaveBeenCalledWith({
          provider: "litellm",
          resolved: { key: "litellm-test-key", source: "flag" },
        });
      } finally {
        rmSync(agentDir, { recursive: true, force: true });
      }
    },
  );
});
