import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig, OpenClawConfig } from "../config/config.js";
import type { SecretRef } from "../config/types.secrets.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import type { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import {
  createApiKeyCredential as keyCredential,
  createAuthProfileStoreFixture as authStore,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { CUSTOM_LOCAL_AUTH_MARKER } from "./model-auth-markers.js";
import {
  attachModelProviderRequestTransport,
  getModelProviderRequestTransport,
} from "./provider-request-config.js";

vi.mock("../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: () => [
    {
      pluginDir: "/bundled/anthropic-vertex",
      origin: "bundled",
      manifest: {
        id: "anthropic-vertex",
        nonSecretAuthMarkers: ["gcp-vertex-credentials"],
      },
    },
  ],
}));

vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider: () => [],
  resolveOwningPluginIdsForProviderRef: () => [],
}));

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
}));

vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => {
  const providerRuntime = {
    buildProviderMissingAuthMessageWithPlugin: () => undefined,
    resolveProviderDeprecatedAuthProfileIds: () => [],
    prepareProviderExternalAuthWithPlugin: async () => undefined,
    shouldDeferProviderSyntheticProfileAuthWithPlugin: (params: {
      context?: { resolvedApiKey?: string };
    }) => params.context?.resolvedApiKey === "synthetic-defer",
    // Synthetic auth is provider-owned. Tests model local/no-key and plugin
    // config credentials without depending on real plugins.
    resolveProviderSyntheticAuthWithPlugin: (params: {
      provider: string;
      config?: OpenClawConfig;
      modelApi?: string;
      context: { providerConfig?: { api?: string; baseUrl?: string; models?: unknown[] } };
    }) => {
      if (params.provider === "plugin-web") {
        if (
          params.config?.plugins?.enabled === false ||
          params.config?.plugins?.entries?.["plugin-web"]?.enabled === false
        ) {
          return undefined;
        }
        const pluginApiKey = params.config?.plugins?.entries?.["plugin-web"]?.config?.apiKey;
        if (typeof pluginApiKey === "string" && pluginApiKey.trim()) {
          return {
            apiKey: pluginApiKey.trim(),
            source: "plugins.entries.plugin-web.config.apiKey",
            mode: "api-key" as const,
          };
        }
        if (pluginApiKey && typeof pluginApiKey === "object") {
          return {
            apiKey: NON_ENV_SECRETREF_MARKER,
            source: "plugins.entries.plugin-web.config.apiKey",
            mode: "api-key" as const,
          };
        }
        return undefined;
      }
      const effectiveApi = params.modelApi ?? params.context.providerConfig?.api;
      if (
        effectiveApi === "ollama" &&
        (params.context.providerConfig?.baseUrl?.startsWith("http://192.168.") ||
          params.modelApi === "ollama")
      ) {
        return {
          apiKey: "ollama-local",
          source: `models.providers.${params.provider} (synthetic local key)`,
          mode: "api-key" as const,
        };
      }
      return undefined;
    },
  };
  return {
    ...providerRuntime,
    prepareProviderSyntheticAuthWithPlugin: async (
      params: Parameters<typeof providerRuntime.resolveProviderSyntheticAuthWithPlugin>[0],
    ) => providerRuntime.resolveProviderSyntheticAuthWithPlugin(params),
  };
});

let applyAuthHeaderOverride: typeof import("./model-auth.js").applyAuthHeaderOverride;
let applyLocalNoAuthHeaderOverride: typeof import("./model-auth.js").applyLocalNoAuthHeaderOverride;
let applySecretRefHeaderSentinels: typeof import("./model-auth.js").applySecretRefHeaderSentinels;
let hasAuth: typeof import("./model-auth.js").hasAvailableAuthForProvider;
let hasRuntimeAvailableProviderAuth: typeof import("./model-auth.js").hasRuntimeAvailableProviderAuth;
let requireApiKey: typeof import("./model-auth.js").requireApiKey;
let resolveModelAuth: typeof import("./model-auth.js").getApiKeyForModelCore;
let resolveAuth: typeof import("./model-auth.js").resolveApiKeyForProviderCore;
let resolveProviderEntryApiKeyAuth: typeof import("./model-auth-provider.js").resolveProviderEntryApiKeyAuth;
let resolveModelAuthMode: typeof import("./model-auth.js").resolveModelAuthMode;
let resolveUsableCustomProviderApiKey: typeof import("./model-auth.js").resolveUsableCustomProviderApiKey;
let cliCredentials: typeof import("./cli-credentials.js");
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
let setRuntimeConfigSnapshot: typeof import("../config/config.js").setRuntimeConfigSnapshot;
let looksLikeSecretSentinel: typeof import("../secrets/sentinel.js").looksLikeSecretSentinel;
let resolveSecretSentinel: typeof import("../secrets/sentinel.js").resolveSecretSentinel;
let setActiveDegradedSecretOwners: typeof import("../secrets/runtime-degraded-state.js").setActiveDegradedSecretOwners;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("./auth-profiles/runtime-snapshots.js").clearRuntimeAuthProfileStoreSnapshots;
let setRuntimeAuthProfileStoreSnapshot: typeof import("./auth-profiles/runtime-snapshots.js").setRuntimeAuthProfileStoreSnapshot;

beforeAll(async () => {
  vi.resetModules();
  ({ clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } = await import("../config/config.js"));
  ({ looksLikeSecretSentinel, resolveSecretSentinel } = await import("../secrets/sentinel.js"));
  ({ setActiveDegradedSecretOwners } = await import("../secrets/runtime-degraded-state.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots, setRuntimeAuthProfileStoreSnapshot } =
    await import("./auth-profiles/runtime-snapshots.js"));
  cliCredentials = await import("./cli-credentials.js");
  ({ resolveProviderEntryApiKeyAuth } = await import("./model-auth-provider.js"));
  ({
    applyAuthHeaderOverride,
    applyLocalNoAuthHeaderOverride,
    applySecretRefHeaderSentinels,
    hasAvailableAuthForProvider: hasAuth,
    hasRuntimeAvailableProviderAuth,
    getApiKeyForModelCore: resolveModelAuth,
    requireApiKey,
    resolveApiKeyForProviderCore: resolveAuth,
    resolveModelAuthMode,
    resolveUsableCustomProviderApiKey,
  } = await import("./model-auth.js"));
});

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearRuntimeAuthProfileStoreSnapshots();
  setActiveDegradedSecretOwners([]);
});

function secretRef(source: SecretRef["source"], id: string, provider: string): SecretRef {
  return { source, id, provider };
}

function providerEntry<T extends Omit<ModelProviderConfig, "baseUrl" | "models">>(
  baseUrl: string,
  options: T,
) {
  const models: ModelProviderConfig["models"] = [];
  return { baseUrl, models, ...options };
}

function configForProviders<T extends Record<string, ModelProviderConfig>>(providers: T) {
  return { models: { providers } };
}

function managedProviderConfig(
  apiKey: ModelProviderConfig["apiKey"] = secretRef("file", "/cliproxy/api-key", "vault"),
  auth?: ModelProviderConfig["auth"],
  baseUrl = "https://cliproxy.example/v1",
) {
  return configForProviders({
    cliproxyapi: providerEntry(baseUrl, {
      api: "openai-responses",
      apiKey,
      ...(auth ? { auth } : {}),
    }),
  });
}

function publishManagedKey(
  apiKey: ModelProviderConfig["apiKey"],
  runtimeKey: string,
  auth?: ModelProviderConfig["auth"],
) {
  const sourceConfig = managedProviderConfig(apiKey, auth);
  const runtimeConfig = configForProviders({
    cliproxyapi: { ...sourceConfig.models.providers.cliproxyapi, apiKey: runtimeKey },
  });
  setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
  return { sourceConfig, runtimeConfig };
}

const modelDefaults = {
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096,
} satisfies Pick<Model, "reasoning" | "input" | "cost" | "contextWindow" | "maxTokens">;

function createModelConfig(overrides: Partial<ModelProviderConfig["models"][number]> = {}) {
  return {
    id: "llama3",
    name: "Llama 3",
    ...modelDefaults,
    ...overrides,
  } satisfies ModelProviderConfig["models"][number];
}

function expectAuthFields(
  auth: Awaited<ReturnType<typeof resolveAuth>>,
  expected: { apiKey: string; mode: "api-key" | "oauth"; source?: string },
) {
  expect(auth.apiKey).toBe(expected.apiKey);
  expect(auth.mode).toBe(expected.mode);
  if (expected.source !== undefined) {
    expect(auth.source).toBe(expected.source);
  }
}

function expectSecret(value: string | undefined, expected: string) {
  expect(looksLikeSecretSentinel(value ?? "")).toBe(true);
  expect(resolveSecretSentinel(value ?? "")).toBe(expected);
}

function expectSecretSentinelAuth(
  auth: Awaited<ReturnType<typeof resolveAuth>>,
  expected: { value: string; source: string; mode: "api-key" | "oauth" },
) {
  const apiKey = auth.apiKey;
  expect(apiKey).toBeDefined();
  if (!apiKey) {
    throw new Error("expected model auth API key");
  }
  expectSecret(apiKey, expected.value);
  expect(auth.source).toBe(expected.source);
  expect(auth.mode).toBe(expected.mode);
}

describe("resolveModelAuthMode", () => {
  it("reports mixed token and API-key profiles", () => {
    expect(
      resolveModelAuthMode(
        "openai",
        undefined,
        authStore({
          token: { type: "token", provider: "openai", token: "token-value" },
          key: keyCredential("openai", "api-key"),
        }),
      ),
    ).toBe("mixed");
  });
  it("does not infer AWS SDK auth from a provider alias", () => {
    expect(resolveModelAuthMode("bedrock", undefined, authStore({}))).toBe("unknown");
  });
  it("honors explicit AWS SDK auth", () => {
    expect(
      resolveModelAuthMode(
        "amazon-bedrock",
        configForProviders({
          "amazon-bedrock": providerEntry("https://bedrock.example", { auth: "aws-sdk" }),
        }),
        authStore({}),
      ),
    ).toBe("aws-sdk");
  });

  it("returns oauth for codex when Codex CLI auth is available", () => {
    const readCodexCliCredentialsCached = vi
      .spyOn(cliCredentials, "readCodexCliCredentialsCached")
      .mockReturnValue({
        type: "oauth",
        provider: "openai",
        access: "token",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      });

    try {
      expect(resolveModelAuthMode("codex", undefined, authStore({}))).toBe("oauth");
      expect(readCodexCliCredentialsCached).toHaveBeenCalledWith({
        ttlMs: 5_000,
        allowKeychainPrompt: false,
      });
    } finally {
      readCodexCliCredentialsCached.mockRestore();
    }
  });
});

describe("requireApiKey", () => {
  it("normalizes line breaks in resolved API keys", () => {
    const auth = { apiKey: "\n sk-test-abc\r\n", source: "env", mode: "api-key" as const };
    expect(requireApiKey(auth, "openai")).toBe("sk-test-abc");
  });

  it("throws typed missing auth errors with source metadata", () => {
    expect(() =>
      requireApiKey({ source: "env: OPENAI_API_KEY", mode: "api-key" }, "openai"),
    ).toThrow(
      expect.objectContaining({
        name: "MissingProviderAuthError",
        message:
          'No API key resolved for provider "openai" (auth mode: api-key, checked: env: OPENAI_API_KEY).',
        code: "missing-api-key",
        provider: "openai",
        mode: "api-key",
        source: "env: OPENAI_API_KEY",
      }),
    );
  });
});

describe("resolveUsableCustomProviderApiKey", () => {
  it("sentinelizes config env SecretRefs on env-first provider resolution", async () => {
    return withEnvAsync({ OPENAI_API_KEY: "sk-secretref-env-first" }, async () => {
      const resolved = await resolveAuth({
        cfg: configForProviders({
          custom: providerEntry("https://example.com/v1", {
            apiKey: secretRef("env", "OPENAI_API_KEY", "default"),
          }),
        }),
        provider: "custom",
        credentialPrecedence: "env-first",
        secretSentinels: true,
        store: authStore({}),
      });

      expect(looksLikeSecretSentinel(resolved.apiKey ?? "")).toBe(true);
      expect(resolveSecretSentinel(resolved.apiKey ?? "")).toBe("sk-secretref-env-first");
    });
  });

  it("does not resolve env SecretRefs when provider allowlist excludes the env id", () => {
    return withEnv({ MY_CUSTOM_KEY: "sk-custom-secretref-env" }, () => {
      const resolved = resolveUsableCustomProviderApiKey({
        cfg: {
          secrets: {
            providers: {
              "custom-env": {
                source: "env",
                allowlist: ["OPENAI_API_KEY"],
              },
            },
          },
          models: {
            providers: {
              custom: providerEntry("https://example.com/v1", {
                apiKey: secretRef("env", "MY_CUSTOM_KEY", "custom-env"),
              }),
            },
          },
        },
        provider: "custom",
      });
      expect(resolved).toBeNull();
    });
  });
});

describe("resolveApiKeyForProviderCore", () => {
  it("keeps provider-entry auth cold when a non-api-key SecretRef fails", async () => {
    const sourceConfig = configForProviders({
      openai: providerEntry("https://api.openai.com/v1", {
        apiKey: "openai:bound",
        headers: {
          "X-Provider-Secret": secretRef("env", "MISSING_OPENAI_HEADER", "default"),
        },
      }),
    });
    setRuntimeConfigSnapshot(sourceConfig, sourceConfig);
    setActiveDegradedSecretOwners([
      {
        ownerKind: "provider",
        ownerId: "openai",
        state: "unavailable",
        paths: ["models.providers.openai.headers.X-Provider-Secret"],
        refKeys: ["env:default:MISSING_OPENAI_HEADER"],
        reason: "secret reference was not found",
      },
    ]);

    await withEnvAsync({ OPENAI_API_KEY: "must-not-be-used" }, async () => {
      await expect(
        resolveProviderEntryApiKeyAuth({
          provider: "openai",
          cfg: sourceConfig,
          store: authStore({
            "openai:bound": keyCredential("openai", "bound-key-must-not-be-used"),
          }),
        }),
      ).rejects.toMatchObject({
        code: "SECRET_SURFACE_UNAVAILABLE",
        ownerKind: "provider",
        ownerId: "openai",
      } satisfies Partial<SecretSurfaceUnavailableError>);
    });
  });

  it("keeps a failed profile ref terminal without cooling an unrelated profile", async () => {
    const agentDir = "/tmp/openclaw-agent-profile-isolation";
    const coldProfileId = "openai:cold";
    const healthyProfileId = "anthropic:healthy";
    const store = authStore({
      [coldProfileId]: {
        type: "api_key" as const,
        provider: "openai",
        key: "stale-key-must-not-be-used",
        keyRef: secretRef("env", "MISSING_OPENAI_KEY", "default"),
      },
      "openai:fallback": keyCredential("openai", "fallback-profile-must-not-be-used"),
      [healthyProfileId]: keyCredential("anthropic", "unused"),
    });
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    const ownerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId: coldProfileId });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId,
        state: "unavailable",
        paths: [`${agentDir}.auth-profiles.${coldProfileId}.key`],
        refKeys: ["env:default:MISSING_OPENAI_KEY"],
        reason: "secret reference was not found",
      },
    ]);
    const cfg = {
      auth: {
        order: {
          openai: [coldProfileId, "openai:fallback"],
          anthropic: [healthyProfileId],
        },
      },
    };

    await expect(
      resolveAuth({
        provider: "anthropic",
        profileId: healthyProfileId,
        cfg,
        store,
        agentDir,
      }),
    ).resolves.toMatchObject({ apiKey: "unused", profileId: healthyProfileId });

    await withEnvAsync({ OPENAI_API_KEY: "unused" }, async () => {
      await expect(resolveAuth({ provider: "openai", cfg, store, agentDir })).rejects.toMatchObject(
        {
          code: "SECRET_SURFACE_UNAVAILABLE",
          ownerKind: "account",
          ownerId,
        } satisfies Partial<SecretSurfaceUnavailableError>,
      );
    });
  });

  it("sentinelizes credentials resolved from auth-profile SecretRefs", async () => {
    const profileId = "openai:secretref";
    const agentDir = "/tmp/openclaw-agent-secretref-sentinel";
    const store = authStore({
      [profileId]: {
        type: "api_key" as const,
        provider: "openai",
        keyRef: secretRef("env", "OPENAI_PROFILE_SECRET", "default"),
      },
    });
    setRuntimeAuthProfileStoreSnapshot(
      authStore({ [profileId]: { ...store.profiles[profileId], key: "test-profile-api-key" } }),
      agentDir,
    );
    const resolved = await resolveAuth({
      provider: "openai",
      profileId,
      secretSentinels: true,
      store,
      agentDir,
    });

    expectSecretSentinelAuth(resolved, {
      value: "test-profile-api-key",
      source: `profile:${profileId}`,
      mode: "api-key",
    });
  });

  it("prefers the active runtime snapshot for SecretRef-backed plugin fallback auth", async () => {
    const pluginConfig = (apiKey: unknown) => ({
      plugins: { entries: { "plugin-web": { config: { apiKey } } } },
    });
    const sourceConfig = pluginConfig(secretRef("file", "/plugin-web/api-key", "vault"));
    setRuntimeConfigSnapshot(pluginConfig("plugin-web-runtime-key"), sourceConfig);

    const resolved = await withEnvAsync({ PLUGIN_WEB_API_KEY: undefined }, () =>
      resolveAuth({
        provider: "plugin-web",
        cfg: sourceConfig,
        secretSentinels: true,
        store: authStore({}),
      }),
    );

    expectSecretSentinelAuth(resolved, {
      value: "plugin-web-runtime-key",
      source: "plugins.entries.plugin-web.config.apiKey",
      mode: "api-key",
    });
  });

  it.each<{ name: string; apiKey: ModelProviderConfig["apiKey"]; runtimeKey?: string }>([
    { name: "generated marker", apiKey: NON_ENV_SECRETREF_MARKER },
    {
      name: "opaque runtime bytes",
      apiKey: secretRef("store", "OPAQUE_KEY", "default"),
      runtimeKey: "  ${OPAQUE_KEY}  ",
    },
  ])(
    "resolves custom provider $name auth from the active runtime snapshot",
    async ({ apiKey, runtimeKey = "sk-runtime-cliproxy" }) => {
      const { sourceConfig } = publishManagedKey(apiKey, runtimeKey);

      const resolved = await resolveAuth({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        secretSentinels: true,
        store: authStore({}),
      });

      expectSecretSentinelAuth(resolved, {
        value: runtimeKey,
        source: "models.providers.cliproxyapi",
        mode: "api-key",
      });
      await expect(
        hasAuth({
          provider: "cliproxyapi",
          cfg: sourceConfig,
          store: authStore({}),
        }),
      ).resolves.toBe(true);
      expect(
        hasRuntimeAvailableProviderAuth({
          provider: "cliproxyapi",
          cfg: sourceConfig,
          allowPluginSyntheticAuth: false,
        }),
      ).toBe(true);
    },
  );

  it("preserves SecretRef provenance for resolved runtime config clones", async () => {
    const { runtimeConfig } = publishManagedKey(undefined, "sk-runtime-clone");

    const resolved = await resolveAuth({
      provider: "cliproxyapi",
      cfg: structuredClone(runtimeConfig),
      secretSentinels: true,
      store: authStore({}),
    });

    expectSecretSentinelAuth(resolved, {
      value: "sk-runtime-clone",
      source: "models.providers.cliproxyapi",
      mode: "api-key",
    });

    const preferred = await resolveAuth({
      provider: "cliproxyapi",
      cfg: structuredClone(runtimeConfig),
      preferredProfile: "cliproxyapi:preferred",
      credentialPrecedence: "profile-first",
      secretSentinels: true,
      store: authStore({
        "cliproxyapi:preferred": keyCredential("cliproxyapi", "sk-preferred-profile"),
      }),
    });
    expectAuthFields(preferred, {
      apiKey: "sk-preferred-profile",
      source: "profile:cliproxyapi:preferred",
      mode: "api-key",
    });
  });

  // Both managed-key paths must enforce the cooldown recorded by the failure writer.
  it.each([
    { name: "no auth override (synthetic-runtime path)", auth: undefined },
    { name: "explicit api-key override path", auth: "api-key" as const },
  ])(
    "blocks a managed file SecretRef apiKey while its inline provider cooldown is active — $name",
    async ({ auth }) => {
      const { sourceConfig } = publishManagedKey(undefined, "sk-runtime-cliproxy", auth);

      const store = {
        version: 1 as const,
        profiles: {},
        usageStats: {
          "inline-api-key:cliproxyapi": {
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing" as const,
          },
        },
      };

      await expect(
        resolveAuth({ provider: "cliproxyapi", cfg: sourceConfig, store }),
      ).rejects.toThrow(/Inline API key for provider "cliproxyapi" is temporarily disabled/);
      await expect(hasAuth({ provider: "cliproxyapi", cfg: sourceConfig, store })).resolves.toBe(
        false,
      );
      expect(
        hasRuntimeAvailableProviderAuth({
          provider: "cliproxyapi",
          cfg: sourceConfig,
          allowPluginSyntheticAuth: false,
          store,
        }),
      ).toBe(false);
    },
  );

  it("does not treat a custom provider managed SecretRef marker as auth without a runtime snapshot", async () => {
    const sourceConfig = managedProviderConfig(NON_ENV_SECRETREF_MARKER);

    await expect(
      resolveAuth({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        store: authStore({}),
      }),
    ).rejects.toThrow('No API key found for provider "cliproxyapi"');
    await expect(
      hasAuth({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        store: authStore({}),
      }),
    ).resolves.toBe(false);
  });

  it("does not resolve custom provider managed SecretRef auth from an unrelated runtime snapshot", async () => {
    const sourceConfig = managedProviderConfig(NON_ENV_SECRETREF_MARKER);
    setRuntimeConfigSnapshot(
      managedProviderConfig("sk-runtime-wrong-source"),
      managedProviderConfig(NON_ENV_SECRETREF_MARKER, undefined, "https://other.example/v1"),
    );

    await expect(
      resolveAuth({
        provider: "cliproxyapi",
        cfg: sourceConfig,
        store: authStore({}),
      }),
    ).rejects.toThrow('No API key found for provider "cliproxyapi"');
  });

  it("reuses the loaded auth profile store after deferring an explicit synthetic profile", async () => {
    const auth = await resolveAuth({
      provider: "custom-auth",
      profileId: "custom-auth:synthetic",
      store: authStore({
        "custom-auth:synthetic": keyCredential("custom-auth", "synthetic-defer"),
        "custom-auth:real": keyCredential("custom-auth", "sk-real"),
      }),
    });

    expectAuthFields(auth, {
      apiKey: "sk-real",
      source: "profile:custom-auth:real",
      mode: "api-key",
    });
  });

  it("prefers explicit api-key provider config over ambient auth profiles", async () => {
    const resolved = await resolveAuth({
      provider: "openai",
      cfg: configForProviders({
        openai: providerEntry("https://api.openai.com/v1", {
          api: "openai-responses",
          auth: "api-key",
          apiKey: "sk-config-live",
        }),
      }),
      store: authStore({
        "openai:default": keyCredential("openai", "sk-profile-stale"),
      }),
    });

    expectAuthFields(resolved, {
      apiKey: "sk-config-live",
      source: "models.json",
      mode: "api-key",
    });
  });

  it("preserves explicit subscription modes for literal provider credentials", async () => {
    for (const mode of ["oauth", "token"] as const) {
      const provider = `custom-${mode}`;
      const resolved = await resolveModelAuth({
        model: {
          id: "subscription-model",
          provider,
          api: "openai-completions",
        } as Model,
        cfg: configForProviders({
          [provider]: providerEntry("https://subscription.example/v1", {
            auth: mode,
            apiKey: "configured-subscription-credential",
          }),
        }),
        store: authStore({}),
      });

      expect(resolved).toMatchObject({
        apiKey: "configured-subscription-credential",
        source: "models.json",
        mode,
      });
    }
  });

  it("does not reinterpret explicit OpenAI oauth material as a Platform API key", async () => {
    await expect(
      resolveModelAuth({
        model: {
          id: "platform-model",
          provider: "openai",
          api: "openai-responses",
        } as Model,
        cfg: configForProviders({
          openai: providerEntry("https://api.openai.com/v1", {
            auth: "oauth",
            apiKey: "configured-subscription-credential",
          }),
        }),
        store: authStore({}),
      }),
    ).rejects.toThrow('No API key found for provider "openai"');
  });

  it("prefers explicit api-key provider SecretRef config over ambient auth profiles", async () => {
    const { sourceConfig } = publishManagedKey(undefined, "sk-runtime-cliproxy", "api-key");

    const resolved = await resolveAuth({
      provider: "cliproxyapi",
      cfg: sourceConfig,
      secretSentinels: true,
      store: authStore({
        "cliproxyapi:default": keyCredential("cliproxyapi", "sk-profile-stale"),
      }),
    });

    expectSecretSentinelAuth(resolved, {
      value: "sk-runtime-cliproxy",
      source: "models.providers.cliproxyapi",
      mode: "api-key",
    });
  });

  it("prefers non-secret local env markers over ambient profiles", async () => {
    const resolved = await withEnvAsync({ OLLAMA_API_KEY: "ollama-local" }, () =>
      resolveAuth({
        provider: "ollama",
        store: authStore({
          "ollama:default": keyCredential("ollama", "ollama-cloud-profile"),
        }),
      }),
    );

    expectAuthFields(resolved, {
      apiKey: "ollama-local",
      mode: "api-key",
    });
    expect(resolved.source).toContain("OLLAMA_API_KEY");
  });
});

describe("resolveApiKeyForProviderCore – synthetic local auth for custom providers", () => {
  it("synthesizes a local auth marker for custom providers with a local baseUrl and no apiKey", async () => {
    const auth = await resolveAuth({
      provider: "custom-ipv6",
      cfg: configForProviders({
        "custom-ipv6": {
          baseUrl: "http://[::1]:8080/v1",
          api: "openai-completions",
          models: [createModelConfig({ id: "qwen-3.5", name: "Qwen 3.5" })],
        },
      }),
    });
    expect(auth.apiKey).toBe(CUSTOM_LOCAL_AUTH_MARKER);
    expect(auth.source).toContain("synthetic local key");
  });

  it("preserves custom named Ollama providers with explicit local marker auth", async () => {
    const auth = await resolveAuth({
      provider: "ollama-remote",
      cfg: configForProviders({
        "ollama-remote": {
          baseUrl: "http://host.docker.internal:11434",
          api: "ollama",
          apiKey: "ollama-local",
          models: [createModelConfig({ id: "qwen3.5:27b", name: "Qwen 3.5 27B" })],
        },
      }),
      store: authStore({}),
    });

    expectAuthFields(auth, {
      apiKey: "ollama-local",
      source: "models.json (local marker)",
      mode: "api-key",
    });
  });

  it("resolves synthetic auth when model overrides api to ollama within a non-ollama provider", async () => {
    const auth = await resolveModelAuth({
      model: {
        id: "my-router/local-llama",
        name: "Local Llama",
        provider: "my-router",
        api: "ollama",
        baseUrl: "http://localhost:11434",
        ...modelDefaults,
      },
      cfg: configForProviders({
        "my-router": {
          baseUrl: "http://localhost:8080/v1",
          api: "openai-completions",
          models: [
            createModelConfig({
              id: "my-router/local-llama",
              name: "Local Llama",
              api: "ollama",
              baseUrl: "http://localhost:11434",
            }),
          ],
        },
      }),
      store: authStore({}),
    });

    expectAuthFields(auth, {
      apiKey: "ollama-local",
      source: "models.providers.my-router (synthetic local key)",
      mode: "api-key",
    });
  });

  it("accepts non-secret local markers for private LAN custom OpenAI-compatible providers", async () => {
    const auth = await resolveAuth({
      provider: "custom-192-168-0-222-11434",
      cfg: configForProviders({
        "custom-192-168-0-222-11434": {
          baseUrl: "http://192.168.0.222:11434/v1",
          api: "openai-completions",
          apiKey: "ollama-local",
          models: [createModelConfig({ id: "qwen3.5:9b", name: "Qwen 3.5 9B" })],
        },
      }),
      store: authStore({}),
    });

    expectAuthFields(auth, {
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.json (local marker)",
      mode: "api-key",
    });
  });

  it("does not accept non-secret local markers for remote custom providers", async () => {
    await expect(
      resolveAuth({
        provider: "custom-remote",
        cfg: configForProviders({
          "custom-remote": {
            baseUrl: "https://api.example.com/v1",
            api: "openai-completions",
            apiKey: "ollama-local",
            models: [createModelConfig({ id: "qwen3.5:9b", name: "Qwen 3.5 9B" })],
          },
        }),
        store: authStore({}),
      }),
    ).rejects.toThrow('No API key found for provider "custom-remote"');
  });

  it("uses implicit aws-sdk auth for built-in Bedrock Converse models", async () => {
    const auth = await resolveModelAuth({
      model: {
        id: "us.anthropic.claude-sonnet-4-6-v1",
        name: "Claude Sonnet",
        provider: "amazon-bedrock",
        api: "bedrock-converse-stream",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        ...modelDefaults,
        reasoning: true,
        contextWindow: 200000,
        maxTokens: 8192,
      },
      store: authStore({}),
    });

    expect(auth.mode).toBe("aws-sdk");
    expect(auth.apiKey).toBeUndefined();
  });
});

describe("applyLocalNoAuthHeaderOverride", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("marks synthetic local OpenAI-compatible auth so SDK request headers clear Authorization", () => {
    const model = applyLocalNoAuthHeaderOverride(
      {
        id: "local-llm",
        name: "local-llm",
        api: "openai-completions",
        provider: "custom",
        baseUrl: "http://127.0.0.1:8080/v1",
        ...modelDefaults,
        headers: { "X-Test": "1" },
      } as Model<"openai-completions">,
      {
        apiKey: CUSTOM_LOCAL_AUTH_MARKER,
        source: "models.providers.custom (synthetic local key)",
        mode: "api-key",
      },
    );

    expect(model.headers?.Authorization).toBeNull();
    expect(model.headers?.["X-Test"]).toBe("1");
  });
});

describe("applyAuthHeaderOverride", () => {
  const baseModel: Model<"openai-completions"> = {
    id: "gemini-3.1-flash-lite",
    name: "gemini-3.1-flash-lite",
    api: "openai-completions" as const,
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    ...modelDefaults,
    contextWindow: 131072,
    maxTokens: 8192,
  };

  it("sentinelizes SecretRef-managed provider headers from the runtime snapshot", () => {
    const sourceConfig = configForProviders({
      google: providerEntry("https://generativelanguage.googleapis.com/v1beta/openai", {
        api: "openai-completions" as const,
        headers: {
          Authorization: "secretref-env:GOOGLE_AUTH_TOKEN",
          "X-Managed": NON_ENV_SECRETREF_MARKER,
        },
      }),
    });
    const runtimeConfig = configForProviders({
      google: {
        ...sourceConfig.models.providers.google,
        headers: {
          Authorization: "Bearer runtime-google-secret",
          "X-Managed": "runtime-managed-secret",
        },
      },
    });
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = applyAuthHeaderOverride(
      {
        ...baseModel,
        headers: {
          Authorization: "Bearer runtime-google-secret",
          "X-Managed": "runtime-managed-secret",
          "X-Plain": "visible",
        },
      },
      null,
      sourceConfig,
    );

    expectSecret(result.headers?.Authorization, "Bearer runtime-google-secret");
    expectSecret(result.headers?.["X-Managed"], "runtime-managed-secret");
    expect(result.headers?.["X-Plain"]).toBe("visible");
  });

  it("sentinelizes SecretRef-managed request headers and composed auth", () => {
    const sourceConfig = configForProviders({
      google: providerEntry("https://generativelanguage.googleapis.com/v1beta/openai", {
        api: "openai-completions" as const,
        request: {
          headers: { "X-Managed": NON_ENV_SECRETREF_MARKER },
          auth: {
            mode: "authorization-bearer" as const,
            token: "secretref-env:GOOGLE_BEARER_TOKEN",
          },
        },
      }),
    });
    const runtimeConfig = configForProviders({
      google: {
        ...sourceConfig.models.providers.google,
        request: {
          headers: { "X-Managed": "runtime-managed-secret" },
          auth: {
            mode: "authorization-bearer" as const,
            token: "runtime-bearer-secret",
          },
        },
      },
    });
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    const result = applySecretRefHeaderSentinels(
      attachModelProviderRequestTransport(
        {
          ...baseModel,
          headers: {
            "X-Managed": "runtime-managed-secret",
            Authorization: "Bearer runtime-bearer-secret",
          },
        },
        runtimeConfig.models.providers.google.request,
      ),
      sourceConfig,
    );

    expectSecret(result.headers?.["X-Managed"], "runtime-managed-secret");
    expectSecret(result.headers?.Authorization?.slice("Bearer ".length), "runtime-bearer-secret");
    const request = getModelProviderRequestTransport(result);
    expectSecret(request?.headers?.["X-Managed"], "runtime-managed-secret");
    expect(request?.auth?.mode).toBe("authorization-bearer");
    expectSecret(
      request?.auth?.mode === "authorization-bearer" ? request.auth.token : undefined,
      "runtime-bearer-secret",
    );
  });

  const baseAuth = { apiKey: "test-api-key", source: "env", mode: "api-key" } as const;
  const provider = providerEntry(baseModel.baseUrl, { api: baseModel.api });
  const enabledConfig = configForProviders({ google: { ...provider, authHeader: true } });

  it.each([
    {
      name: "authHeader is not set",
      cfg: configForProviders({ google: provider }),
      auth: baseAuth,
    },
    {
      name: "API key is a synthetic marker",
      cfg: enabledConfig,
      auth: { ...baseAuth, apiKey: CUSTOM_LOCAL_AUTH_MARKER, source: "synthetic" },
    },
  ])("returns model unchanged when $name", ({ cfg, auth }) => {
    expect(applyAuthHeaderOverride(baseModel, auth, cfg)).toBe(baseModel);
  });

  it("strips existing authorization header case-insensitively before injection", () => {
    const result = applyAuthHeaderOverride(
      { ...baseModel, headers: { authorization: "old-value", "X-Custom": "keep" } },
      { apiKey: "test-api-key", source: "env", mode: "api-key" },
      enabledConfig,
    );

    expect(result.headers).toEqual({
      "X-Custom": "keep",
      Authorization: "Bearer test-api-key",
    });
  });
});
