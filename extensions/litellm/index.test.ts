import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
  registerProviderPlugin,
  requireRegisteredProvider,
  runProviderCatalog,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { afterEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const PROXY_URL = "https://litellm.example/v1";
vi.mock("openclaw/plugin-sdk/provider-setup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-setup")>();
  return {
    ...actual,
    discoverOpenAICompatibleLocalModels: async () => ({
      kind: "success",
      health: "unknown",
      rows: [{ model: { id: "custom-model" } }],
      fetchedAt: Date.now(),
    }),
  };
});

const LITELLM_DEFAULT_MODEL = {
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

const AUTHORED_MODEL: ModelDefinitionConfig = {
  id: "custom-model",
  name: "Custom",
  reasoning: false,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100,
};

function textPrompter(answer: string) {
  return createTestWizardPrompter({ text: vi.fn(async () => answer) as WizardPrompter["text"] });
}

function providerConfig(
  providers: Record<string, ModelProviderConfig>,
  mode?: "merge" | "replace",
): OpenClawConfig {
  return { models: { providers, ...(mode ? { mode } : {}) } };
}

function registerProvider() {
  const [provider] = capturePluginRegistration(plugin).providers;
  expect(provider?.id).toBe("litellm");
  return provider;
}

async function runInteractiveAuth(params: {
  config?: OpenClawConfig;
  prompter: WizardPrompter;
  key?: string;
}) {
  const auth = registerProvider()?.auth?.[0];
  return await auth?.run({
    config: params.config ?? {},
    opts: { litellmApiKey: params.key ?? "litellm-test-key" },
    env: {},
    runtime: createRuntimeSpies(),
    prompter: params.prompter,
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
}

async function runNonInteractiveAuth(
  config: OpenClawConfig,
  key: string,
  opts: ProviderAuthMethodNonInteractiveContext["opts"] = {},
  overrides: Partial<ProviderAuthMethodNonInteractiveContext> = {},
) {
  return await registerProvider()?.auth?.[0]?.runNonInteractive?.({
    authChoice: "litellm-api-key",
    config,
    baseConfig: config,
    opts,
    runtime: createRuntimeSpies(),
    resolveApiKey: async () => ({ key, source: "profile" }),
    toApiKeyCredential: () => null,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearLiveCatalogCacheForTests();
});

it.each([
  { authMode: "interactive", modelsMode: "merge" },
  { authMode: "non-interactive", modelsMode: "replace" },
] as const)(
  "preserves an explicit proxy's authored models through registered $authMode auth in $modelsMode mode",
  async ({ authMode, modelsMode }) => {
    const authoredModels = [structuredClone(AUTHORED_MODEL)];
    const config = providerConfig(
      {
        litellm: {
          baseUrl: "https://litellm.example/v1",
          api: "anthropic-messages",
          apiKey: "  old-key  ",
          models: structuredClone(authoredModels),
        },
      },
      modelsMode,
    );
    let result: OpenClawConfig | null | undefined;
    if (authMode === "non-interactive") {
      result = await runNonInteractiveAuth(config, "old-key", {
        customBaseUrl: "https://litellm.example/v1/",
      });
    } else {
      const interactive = await runInteractiveAuth({
        config,
        key: "old-key",
        prompter: createTestWizardPrompter(),
      });
      expect(interactive?.profiles).toEqual([
        {
          profileId: "litellm:default",
          credential: { type: "api_key", provider: "litellm", key: "old-key" },
        },
      ]);
      result = applyProviderAuthConfigPatch({}, interactive?.configPatch, interactive);
    }
    expect(result?.models?.mode).toBe(modelsMode);
    expect(result?.models?.providers?.litellm).toEqual({
      baseUrl: "https://litellm.example/v1",
      api: "openai-completions",
      apiKey: "old-key",
      models: [...authoredModels, ...(modelsMode === "replace" ? [LITELLM_DEFAULT_MODEL] : [])],
    });
  },
);

it.each([
  ["https://litellm.example/v1//", "https://litellm.example/v1", undefined],
  ["http://localhost:4000", "http://localhost:4000", undefined],
  ["", "http://localhost:4000", undefined],
  ["  https://litellm.example/v1  ", "https://litellm.example/v1", "https://old.example"],
  ["http://localhost:4000", "http://localhost:4000", "https://old.example"],
] as const)(
  "interactive setup normalizes %j to %j from %j and selects a served model",
  async (answer, expectedBaseUrl, initialValue) => {
    const prompter = textPrompter(answer);
    const config = initialValue
      ? providerConfig({ litellm: { baseUrl: initialValue, models: [] } })
      : {};
    const result = await runInteractiveAuth({ config, prompter });
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "LiteLLM proxy base URL",
        placeholder: "http://localhost:4000",
        initialValue,
      }),
    );
    expect(result?.configPatch?.models?.providers?.litellm).toStrictEqual({
      baseUrl: expectedBaseUrl,
      api: "openai-completions",
      models: [expect.objectContaining({ id: "custom-model" })],
    });
  },
);

it.each([
  { withCanonical: false, authMode: "interactive" },
  { withCanonical: true, authMode: "interactive" },
  { withCanonical: false, authMode: "non-interactive" },
  { withCanonical: true, authMode: "non-interactive" },
] as const)(
  "preserves authored settings through $authMode auth with a canonical row present: $withCanonical",
  async ({ withCanonical, authMode }) => {
    const alias: ModelProviderConfig = {
      baseUrl: "https://old.example/v1",
      api: "anthropic-messages",
      apiKey: "old-key",
      request: { allowPrivateNetwork: true },
      models: [structuredClone(AUTHORED_MODEL)],
    };
    const canonical: ModelProviderConfig = {
      ...alias,
      baseUrl: "https://canonical.example/v1",
      apiKey: "canonical-key",
      models: [{ ...structuredClone(AUTHORED_MODEL), params: { temperature: 0.3 } }],
    };
    const selected = withCanonical ? canonical : alias;
    const expectedProvider = {
      ...structuredClone(selected),
      baseUrl: authMode === "interactive" ? "https://selected.example/v1" : selected.baseUrl,
      api: "openai-completions",
    };
    const prompter = textPrompter("https://selected.example/v1");
    const config = providerConfig({
      LiteLLM: alias,
      ...(withCanonical ? { litellm: canonical } : {}),
    });
    let providers: Record<string, ModelProviderConfig> | undefined;
    if (authMode === "interactive") {
      const result = await runInteractiveAuth({ config, prompter });
      expect(prompter.text).toHaveBeenCalledWith(
        expect.objectContaining({ initialValue: selected.baseUrl }),
      );
      providers = applyProviderAuthConfigPatch(config, result?.configPatch, result).models
        ?.providers;
    } else {
      const result = await runNonInteractiveAuth(
        config,
        withCanonical ? "canonical-key" : "old-key",
      );
      providers = result?.models?.providers;
    }
    expect(providers).toStrictEqual({ litellm: expectedProvider });
  },
);

it.each([
  { answer: "not-a-url", expected: "Enter a full URL, such as http://localhost:4000" },
  { answer: "ftp://litellm.example", expected: "must start with http:// or https://" },
])("blocks $answer at the proxy prompt", async ({ answer, expected }) => {
  const prompter = createTestWizardPrompter({
    text: vi.fn(async ({ validate }) => {
      expect(validate).toBeTypeOf("function");
      expect(validate?.(answer)).toContain(expected);
      for (const accepted of ["", "http://localhost:4000", "https://litellm.example/v1"]) {
        expect(validate?.(accepted)).toBeUndefined();
      }
      // Mirror the real prompter refusing to submit an invalid URL.
      throw new WizardCancelledError();
    }) as WizardPrompter["text"],
  });
  await expect(runInteractiveAuth({ prompter })).rejects.toThrow(WizardCancelledError);
});

it.each([
  [undefined, "http://localhost:4000/v1/models"],
  ["https://litellm.example", `${PROXY_URL}/models`],
  [" https://proxy.example/litellm/v1// ", "https://proxy.example/litellm/v1/models"],
  [PROXY_URL, `${PROXY_URL}/models`, "LiteLLM"],
  [PROXY_URL, `${PROXY_URL}/models`, "LiteLLM", "https://litellm.example"],
] as const)(
  "discovers models from %j at %j (provider %j, canonical URL %j)",
  async (baseUrl, endpoint, configuredKey?: string, canonicalBaseUrl?: string) => {
    const providerKey = configuredKey ?? "litellm";
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
      config: baseUrl
        ? providerConfig({
            [providerKey]: { baseUrl, models: [] },
            ...(canonicalBaseUrl ? { litellm: { baseUrl: canonicalBaseUrl, models: [] } } : {}),
          })
        : {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "LITELLM_API_KEY", discoveryApiKey: "sk-test" }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
    });
    expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([endpoint]);
    expect(result).toMatchObject({
      provider: { models: [expect.objectContaining({ id: "proxy-model" })] },
      outcomes: [{ provider: "litellm", status: "ready" }],
    });
  },
);

it.each([
  ["https://litellm.example/v1/", "https://litellm.example/v1", []],
  [undefined, "http://localhost:4000", [LITELLM_DEFAULT_MODEL]],
] as const)(
  "configures proxy URL %j for fresh setup",
  async (baseUrl, expectedBaseUrl, expectedModels) => {
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
      const result = await runNonInteractiveAuth(
        {},
        "litellm-test-key",
        { litellmApiKey: "litellm-test-key", customBaseUrl: baseUrl },
        { agentDir, resolveApiKey, toApiKeyCredential },
      );
      expect(result?.auth).toStrictEqual({
        profiles: { "litellm:default": { provider: "litellm", mode: "api_key" } },
      });
      expect(result?.agents?.defaults).toStrictEqual({
        models: { "litellm/claude-opus-4-6": { alias: "LiteLLM" } },
        model: { primary: "litellm/claude-opus-4-6" },
      });
      expect(result?.models).toStrictEqual({
        mode: "merge",
        providers: {
          litellm: {
            baseUrl: expectedBaseUrl,
            api: "openai-completions",
            models: expectedModels,
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
