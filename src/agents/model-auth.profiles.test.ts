import fs from "node:fs/promises";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import type { SecretRef } from "../config/types.secrets.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential as keyCredential,
  createAuthProfileStoreFixture as authStore,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { clearAuthProfileMigrationDiagnostics } from "./auth-profiles/legacy-source-diagnostic.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  writePersistedAuthProfileStoreRaw,
} from "./auth-profiles/sqlite.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import type { AuthProfileCredential, OAuthCredential } from "./auth-profiles/types.js";
import { upsertAuthProfileWithLockOrThrow } from "./auth-profiles/upsert-with-lock.js";
import { resolveInlineProviderApiKeyUsageId } from "./auth-profiles/usage.js";
import { resolveLegacyInheritedAuthDir } from "./legacy-inherited-auth-dir.js";
import {
  createRuntimeProviderAuthLookup,
  getApiKeyForModelCore as resolveModelAuth,
  hasAvailableAuthForProvider as hasAuth,
  hasRuntimeAvailableProviderAuth,
  prepareRuntimeAvailableProviderAuth,
  resolveApiKeyForProviderCore as resolveAuth,
  resolveEnvApiKey,
} from "./model-auth.js";

function secretRef(source: SecretRef["source"], id: string, provider: string): SecretRef {
  return { source, id, provider };
}

function providerEntry(
  baseUrl: string,
  options: Omit<ModelProviderConfig, "baseUrl" | "models"> = {},
): ModelProviderConfig {
  return { baseUrl, models: [], ...options };
}

function configForProviders(providers: Record<string, ModelProviderConfig>): OpenClawConfig {
  return { models: { providers } };
}

function testModelDefinition(id: string): ModelProviderConfig["models"][number] {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: ({ provider }: { provider: string; env: NodeJS.ProcessEnv }) => {
    if (provider !== "anthropic-vertex") {
      return undefined;
    }
    return {
      resolveConfigApiKey: ({ env }: { env: NodeJS.ProcessEnv }) =>
        ["1", "true"].includes(env.ANTHROPIC_VERTEX_USE_GCP_METADATA?.trim().toLowerCase() ?? "")
          ? "gcp-vertex-credentials"
          : undefined,
    };
  },
}));

vi.mock("./model-auth-env-vars.js", () => {
  const candidates = {
    anthropic: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
    "demo-local": ["DEMO_LOCAL_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    zai: ["ZAI_API_KEY", "Z_AI_API_KEY"],
  } as const;

  const authEvidenceMap = {
    "google-vertex": [
      {
        type: "local-file-with-env",
        fileEnvVar: "GOOGLE_APPLICATION_CREDENTIALS",
        fallbackPaths: ["${HOME}/.config/gcloud/application_default_credentials.json"],
        requiresAnyEnv: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
        requiresAllEnv: ["GOOGLE_CLOUD_LOCATION"],
        credentialMarker: "gcp-vertex-credentials",
        source: "gcloud adc",
      },
    ],
  } satisfies Record<string, readonly unknown[]>;
  return {
    listKnownProviderEnvApiKeyNames: () => [...new Set(Object.values(candidates).flat())],
    resolveProviderEnvAuthLookupMaps: () => ({
      aliasMap: {},
      envCandidateMap: candidates,
      authEvidenceMap,
      setupProviderFallbackRefs: ["anthropic-vertex"],
    }),
  };
});

vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  formatProviderAuthProfileApiKeyWithPlugin: async () => undefined,
  refreshProviderOAuthCredentialWithPlugin: async () => null,
  resolveProviderDeprecatedAuthProfileIds: ({ provider }: { provider: string }) =>
    provider === "anthropic" || provider === "claude-cli" ? ["anthropic:claude-cli"] : [],
  prepareProviderExternalAuthWithPlugin: async () => undefined,
  prepareProviderSyntheticAuthWithPlugin: async () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: (params: {
    provider: string;
    context: { resolvedApiKey?: string };
  }) => {
    const expectedMarker = params.provider === "demo-local" ? "demo-local" : undefined;
    return Boolean(expectedMarker && params.context.resolvedApiKey?.trim() === expectedMarker);
  },
}));

vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProvider: ({ provider }: { provider: string }) =>
    provider === "openai" ? ["openai"] : [],
  resolveOwningPluginIdsForProviderRef: ({ provider }: { provider: string }) =>
    provider === "openai" ? ["openai"] : [],
}));

const cliCredentialMocks = vi.hoisted(() => ({
  readCodexCliCredentialsCached: vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
  readMiniMaxCliCredentialsCached: vi.fn<(options?: unknown) => OAuthCredential | null>(() => null),
}));

vi.mock("./cli-credentials.js", () => cliCredentialMocks);

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  cliCredentialMocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
  cliCredentialMocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
});

afterEach(clearRuntimeAuthProfileStoreSnapshots);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const oauthFixture = {
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 30 * 60 * 1000,
  accountId: "acct_123",
};

const BEDROCK_PROVIDER_CFG = {
  models: {
    providers: {
      "amazon-bedrock": providerEntry("https://bedrock-runtime.us-east-1.amazonaws.com", {
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
      }),
    },
  },
} satisfies OpenClawConfig;

const BEDROCK_PROVIDER_CFG_WITH_PROFILE = {
  ...BEDROCK_PROVIDER_CFG,
  auth: {
    order: {
      "amazon-bedrock": ["amazon-bedrock:default"],
    },
    profiles: {
      "amazon-bedrock:default": {
        provider: "amazon-bedrock",
        mode: "aws-sdk",
      },
    },
  },
} satisfies OpenClawConfig;

it.each(["amazon-bedrock:default", undefined])(
  "resolves config-only AWS SDK auth with explicit profile %s",
  async (profileId) => {
    const resolved = await resolveAuth({
      provider: "amazon-bedrock",
      profileId,
      store: authStore({}),
      cfg: BEDROCK_PROVIDER_CFG_WITH_PROFILE,
    });
    expect(resolved.mode).toBe("aws-sdk");
    expect(resolved.profileId).toBe("amazon-bedrock:default");
    expect(resolved.source).toBe("profile:amazon-bedrock:default");
    expect(resolved.apiKey).toBeUndefined();
  },
);

function cooldownStore(
  provider: string,
  profiles: import("./auth-profiles.js").AuthProfileStore["profiles"] = {},
) {
  return {
    ...authStore(profiles),
    usageStats: {
      [resolveInlineProviderApiKeyUsageId(provider)]: {
        disabledUntil: Date.now() + 60_000,
        disabledReason: "billing" as const,
      },
    },
  };
}

function configuredAgent(agentDir: string) {
  return { list: [{ id: "configured", default: true, agentDir }] };
}

function buildDemoLocalStore(keys: string[]) {
  return authStore(
    Object.fromEntries(
      keys.map((key, index) => [
        index === 0 ? "demo-local:default" : `demo-local:${index + 1}`,
        keyCredential("demo-local" as const, key),
      ]),
    ),
  );
}

function buildDemoLocalProviderCfg(apiKey: string): OpenClawConfig {
  return configForProviders({
    "demo-local": providerEntry("https://local-provider.example", {
      api: "openai-completions",
      apiKey,
    }),
  });
}

async function resolveDemoLocalApiKey(params: {
  envApiKey: string | undefined;
  storedKeys: string[];
  configuredApiKey: string;
}) {
  return await withEnvAsync({ DEMO_LOCAL_API_KEY: params.envApiKey }, async () => {
    return await resolveAuth({
      provider: "demo-local",
      store: buildDemoLocalStore(params.storedKeys),
      cfg: buildDemoLocalProviderCfg(params.configuredApiKey),
    });
  });
}

describe("shared auth profile read-through", () => {
  it.each([
    {
      name: "reads a shared API key without a local profile",
      baseKey: "shared-state-key",
      legacy: false,
      localKey: undefined,
    },
    {
      name: "keeps the populated legacy main store authoritative before relocation",
      baseKey: "legacy-main-key",
      legacy: true,
      localKey: undefined,
    },
    {
      name: "lets an agent-local profile override its shared read-through base",
      baseKey: "shared-state-key",
      legacy: false,
      localKey: "agent-local-key",
    },
  ])("$name", async ({ baseKey, legacy, localKey }) => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-auth-read-through-",
        agentEnv: "main",
        env: { OPENAI_API_KEY: undefined },
      },
      async (state) => {
        const profileId = "openai:manual";
        const mainAgentDir = state.agentDir();
        const agentDir = state.agentDir("worker");
        const credential = keyCredential("openai", baseKey);

        if (legacy) {
          writePersistedAuthProfileStoreRaw(authStore({ [profileId]: credential }), mainAgentDir);
        }
        await upsertAuthProfileWithLockOrThrow({
          profileId,
          credential,
          agentDir: mainAgentDir,
        });
        if (localKey) {
          writePersistedAuthProfileStoreRaw(
            authStore({ [profileId]: { ...credential, key: localKey } }),
            agentDir,
          );
        }

        expect(inspectPersistedAuthProfileStoreRaw(mainAgentDir).status).toBe(
          legacy ? "readable" : "missing",
        );
        expect(inspectPersistedAuthProfileStoreRaw(agentDir).status).toBe(
          localKey ? "readable" : "missing",
        );

        const inheritedAuthDir = resolveLegacyInheritedAuthDir({}, state.env);
        const store = ensureAuthProfileStore(agentDir, {
          allowKeychainPrompt: false,
          syncExternalCli: false,
          ...(inheritedAuthDir ? { inheritedAuthDir } : {}),
        });
        const resolved = await resolveAuth({
          provider: "openai",
          cfg: {},
          agentDir,
          store,
        });

        expect(resolved.apiKey).toBe(localKey ?? baseKey);
        expect(resolved.source).toBe(`profile:${profileId}`);
      },
    );
  });
});

describe("getApiKeyForModelCore", () => {
  it("keeps OpenAI OAuth profiles on the Codex transport and API keys on direct OpenAI", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-oauth-", agentEnv: "main" },
      async (state) => {
        await state.writeAuthProfiles(
          authStore({
            "openai:chatgpt": {
              type: "oauth" as const,
              provider: "openai",
              ...oauthFixture,
            },
            "openai:api-key": keyCredential("openai", "direct-openai-key"),
          }),
        );
        const agentDir = state.agentDir();
        const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });

        const directAuth = await resolveModelAuth({
          model: {
            id: "chat-latest",
            provider: "openai",
            api: "openai-responses",
          } as Model,
          store,
          agentDir,
        });
        const codexAuth = await resolveModelAuth({
          model: {
            id: "gpt-5.5",
            provider: "openai",
            api: "openai-chatgpt-responses",
          } as Model,
          store,
          agentDir,
        });

        expect(directAuth).toMatchObject({
          apiKey: "direct-openai-key",
          mode: "api-key",
          profileId: "openai:api-key",
        });
        expect(codexAuth).toMatchObject({
          apiKey: oauthFixture.access,
          mode: "oauth",
          profileId: "openai:chatgpt",
        });
      },
    );
  });

  it("resolves ChatGPT token-sharing as renewable OAuth for public Responses", async () => {
    await expect(
      resolveModelAuth({
        model: {
          id: "gpt-5.5",
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        } as Model,
        profileId: "openai:shared",
        lockedProfile: true,
        store: authStore({
          "openai:shared": {
            type: "oauth",
            provider: "openai",
            ...oauthFixture,
            authFlow: "chatgpt-token-sharing",
          },
        }),
      }),
    ).resolves.toMatchObject({
      apiKey: oauthFixture.access,
      mode: "oauth",
      authFlow: "chatgpt-token-sharing",
      profileId: "openai:shared",
    });
  });

  it.each([["chatgpt-token-sharing", "openai-responses", "https://proxy.example/v1"]])(
    "rejects %s for %s at %s before returning a bearer",
    async (authFlow, api, baseUrl) => {
      await expect(
        resolveModelAuth({
          model: { id: "gpt-5.5", provider: "openai", api, baseUrl } as Model,
          profileId: "openai:shared",
          lockedProfile: true,
          store: authStore({
            "openai:shared": { type: "oauth", provider: "openai", ...oauthFixture, authFlow },
          }),
        }),
      ).rejects.toThrow(/requires (the public OpenAI Responses endpoint|token-sharing consent)/);
    },
  );

  it("rejects an explicit OpenAI API-key profile for the Codex transport", async () => {
    const store = authStore({
      "openai:api-key": keyCredential("openai", "direct-openai-key"),
    });

    await expect(
      resolveModelAuth({
        model: {
          id: "gpt-5.5",
          provider: "openai",
          api: "openai-chatgpt-responses",
        } as Model,
        profileId: "openai:api-key",
        lockedProfile: true,
        store,
      }),
    ).rejects.toThrow(/requires a ChatGPT subscription \(OAuth or token\) profile/);
  });

  it("uses the config default agent dir for inline provider cooldown checks", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-inline-cooldown-agent-dir-",
        agentEnv: "clear",
      },
      async (state) => {
        await state.writeAuthProfiles(cooldownStore("demo-local"), "configured");

        const cfg: OpenClawConfig = {
          ...buildDemoLocalProviderCfg("DEMO_LOCAL_API_KEY"),
          agents: configuredAgent(state.agentDir("configured")),
        };

        await withEnvAsync({ DEMO_LOCAL_API_KEY: "env-demo-key" }, async () => {
          await expect(resolveAuth({ provider: "demo-local", cfg })).rejects.toThrow(
            /Inline API key for provider "demo-local" is temporarily disabled/,
          );
        });
      },
    );
  });

  it("does not read unrelated external CLI credentials when resolving provider auth", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-auth-scope-",
        agentEnv: "main",
        env: {
          OPENAI_API_KEY: undefined,
        },
      },
      async (state) => {
        writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
        const error = await resolveAuth({
          provider: "openai",
          agentDir: state.agentDir(),
        }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          code: "missing-provider-auth",
          provider: "openai",
        });
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(
          `Auth store: ${resolveOpenClawStateSqlitePath(state.env)} (agentDir: ${state.agentDir()}).`,
        );
        expect((error as Error).message).toContain(
          "openclaw models auth paste-api-key --provider openai",
        );
        expect((error as Error).message).not.toContain("openclaw agents add");
      },
    );

    expect(cliCredentialMocks.readCodexCliCredentialsCached).not.toHaveBeenCalled();
    expect(cliCredentialMocks.readMiniMaxCliCredentialsCached).not.toHaveBeenCalled();
  });

  it("skips malformed stored ZAI command profiles and uses current env auth", async () => {
    await withEnvAsync(
      {
        ZAI_API_KEY: "zai-current-key", // pragma: allowlist secret
        Z_AI_API_KEY: undefined,
      },
      async () => {
        const resolved = await resolveAuth({
          provider: "zai",
          store: authStore({
            "zai:default": keyCredential("zai", "openclaw onboard --auth-choice zai-coding-global"),
          }),
        });
        expect(resolved.apiKey).toBe("zai-current-key");
        expect(resolved.source).toContain("ZAI_API_KEY");
        expect(resolved.profileId).toBeUndefined();
      },
    );
  });

  it.each([
    ["vllm", "http://127.0.0.1:8000/v1", true],
    ["remote", "https://remote.example.com/v1", false],
  ] as const)("reports prepared auth availability for %s", async (provider, baseUrl, available) => {
    await expect(
      prepareRuntimeAvailableProviderAuth({
        provider,
        cfg: configForProviders({
          [provider]: {
            api: "openai-completions",
            baseUrl,
            models: [testModelDefinition("fixture-model")],
          },
        }),
        env: {},
        store: authStore({}),
      }),
    ).resolves.toBe(available);
  });

  it.each([false, true])(
    "honors inline cooldown with healthy profile available = %s",
    async (healthy) => {
      await withEnvAsync({ INLINE_CLOUD_API_KEY: "env-cloud-key" }, async () => {
        const store = cooldownStore(
          "inline-cloud",
          healthy
            ? {
                "inline-cloud:default": keyCredential("inline-cloud", "stored-cloud-key"),
              }
            : {},
        );
        const cfg = configForProviders({
          "inline-cloud": providerEntry("https://inline-cloud.example", {
            api: "openai-completions",
            apiKey: "INLINE_CLOUD_API_KEY",
          }),
        });
        await expect(hasAuth({ provider: "inline-cloud", store, cfg })).resolves.toBe(healthy);
        if (healthy) {
          const resolved = await resolveAuth({
            provider: "inline-cloud",
            store,
            cfg,
          });
          expect(resolved.apiKey).toBe("stored-cloud-key");
          expect(resolved.source).toBe("profile:inline-cloud:default");
        } else {
          await expect(resolveAuth({ provider: "inline-cloud", store, cfg })).rejects.toThrow(
            /Inline API key for provider "inline-cloud" is temporarily disabled/,
          );
        }
      });
    },
  );

  it("falls back to the stored synthetic local profile when no real auth exists", async () => {
    const resolved = await resolveDemoLocalApiKey({
      envApiKey: undefined,
      storedKeys: ["demo-local"],
      configuredApiKey: "DEMO_LOCAL_API_KEY",
    });
    expect(resolved.apiKey).toBe("demo-local");
    expect(resolved.source).toBe("profile:demo-local:default");
    expect(resolved.profileId).toBe("demo-local:default");
  });

  it("defers every stored synthetic local profile until real auth sources are checked", async () => {
    const resolved = await resolveDemoLocalApiKey({
      envApiKey: "env-demo-key",
      storedKeys: ["demo-local", "demo-local"],
      configuredApiKey: "DEMO_LOCAL_API_KEY",
    });
    expect(resolved.apiKey).toBe("env-demo-key");
    expect(resolved.source).toContain("DEMO_LOCAL_API_KEY");
    expect(resolved.profileId).toBeUndefined();
  });

  it.each([
    ["bearer", "AWS_BEARER_TOKEN_BEDROCK"],
    ["access", "AWS_ACCESS_KEY_ID"],
    ["profile", "AWS_PROFILE"],
  ])("prefers Bedrock %s credentials over lower-priority sources", async (kind, source) => {
    await withEnvAsync(
      {
        AWS_BEARER_TOKEN_BEDROCK: kind === "bearer" ? "bedrock-token" : undefined,
        AWS_ACCESS_KEY_ID: kind === "profile" ? undefined : "access-key",
        AWS_SECRET_ACCESS_KEY: kind === "profile" ? undefined : "secret-key",
        AWS_PROFILE: "profile",
      },
      async () => {
        const resolved = await resolveAuth({
          provider: "amazon-bedrock",
          cfg: BEDROCK_PROVIDER_CFG,
          store: authStore({}),
        });
        expect(resolved.mode).toBe("aws-sdk");
        expect(resolved.apiKey).toBeUndefined();
        expect(resolved.source).toContain(source);
      },
    );
  });

  it("resolveEnvApiKey('google-vertex') keeps ADC fallback when manifest env candidates are empty", async () => {
    const tempDir = tempDirs.make("openclaw-google-adc-candidates-");
    const credentialsPath = path.join(tempDir, "認証情報-adc.json");
    await fs.writeFile(credentialsPath, "{}", "utf8");

    const resolved = resolveEnvApiKey(
      "google-vertex",
      {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
      } as NodeJS.ProcessEnv,
      { candidateMap: { "google-vertex": ["GOOGLE_CLOUD_API_KEY"] } },
    );

    expect(resolved?.apiKey).toBe("gcp-vertex-credentials");
    expect(resolved?.source).toBe("gcloud adc");
  });

  it("resolveEnvApiKey('google-vertex') rejects missing explicit ADC path before fallback paths", async () => {
    const homeDir = tempDirs.make("openclaw-google-adc-home-");
    const fallbackDir = path.join(homeDir, ".config", "gcloud");
    const missingCredentialsPath = path.join(homeDir, "missing-adc.json");
    await fs.mkdir(fallbackDir, { recursive: true });
    await fs.writeFile(
      path.join(fallbackDir, "application_default_credentials.json"),
      "{}",
      "utf8",
    );

    const resolved = resolveEnvApiKey("google-vertex", {
      GOOGLE_APPLICATION_CREDENTIALS: missingCredentialsPath,
      GOOGLE_CLOUD_LOCATION: "us-central1",
      GOOGLE_CLOUD_PROJECT: "vertex-project",
      HOME: homeDir,
    } as NodeJS.ProcessEnv);

    expect(resolved).toBeNull();
  });

  it.each([
    ["anthropic-vertex", true],
    ["other-vertex", false],
  ] as const)("limits prepared setup auth to declared provider %s", (provider, available) => {
    expect(
      hasRuntimeAvailableProviderAuth({
        provider,
        env: { ANTHROPIC_VERTEX_USE_GCP_METADATA: "true" },
        runtimeLookup: createRuntimeProviderAuthLookup({ env: {} }),
      }),
    ).toBe(available);
  });
});

describe("resolveApiKeyForProviderCore — per-entry apiKey as profile ID reference", () => {
  it.each(["both", "invalid persisted"])(
    "isolates legacy migration to its providers with %s snapshots",
    async (snapshot) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-provider-migration-" },
        async (state) => {
          const agentDir = state.agentDir("worker");
          await fs.mkdir(agentDir, { recursive: true });
          const legacyPath = path.join(agentDir, "auth-profiles.json");
          const legacyBytes = JSON.stringify(
            authStore({
              "anthropic:default": keyCredential("anthropic", "legacy-key"),
            }),
          );
          await fs.writeFile(legacyPath, legacyBytes);
          const persistedProfiles =
            snapshot === "invalid persisted"
              ? { "invalid:default": { type: "invalid", provider: "invalid" } }
              : {};
          writePersistedAuthProfileStoreRaw(authStore(persistedProfiles), agentDir);
          replaceRuntimeAuthProfileStoreSnapshots([
            ...(snapshot === "both" ? [{ store: authStore({}) }] : []),
            ...(snapshot === "both" ? [{ agentDir, store: authStore({}) }] : []),
          ]);
          const cfg: OpenClawConfig = configForProviders({
            litellm: providerEntry("https://litellm.example.test/v1", {
              apiKey: "litellm-key",
            }),
            anthropic: providerEntry("https://anthropic.example.test/v1", {
              apiKey: "fallback-key",
            }),
          });
          try {
            for (const store of [undefined, authStore({})]) {
              await expect(
                resolveAuth({ provider: "litellm", agentDir, cfg, store }),
              ).resolves.toMatchObject({ apiKey: "litellm-key" });
              await expect(
                resolveAuth({ provider: "anthropic", agentDir, cfg, store }),
              ).rejects.toMatchObject({
                code: "AUTH_PROFILE_MIGRATION_REQUIRED",
                affectedProviders: ["anthropic"],
                message: expect.stringContaining(
                  "affected providers: anthropic; run openclaw doctor --fix",
                ),
              });
            }
            expect(await fs.readFile(legacyPath, "utf8")).toBe(legacyBytes);
            expect(inspectPersistedAuthProfileStoreRaw(agentDir)).toMatchObject({
              status: "readable",
              raw: { profiles: persistedProfiles },
            });
            await fs.writeFile(
              legacyPath,
              JSON.stringify(
                authStore({
                  "nvidia:default": keyCredential("nvidia", "new-legacy-key"),
                }),
              ),
            );
            for (const removeSource of [false, true]) {
              if (removeSource) {
                await fs.rm(legacyPath);
              }
              await expect(
                resolveAuth({ provider: "litellm", agentDir, cfg }),
              ).resolves.toMatchObject({ apiKey: "litellm-key" });
              for (const provider of ["anthropic", "nvidia"]) {
                await expect(resolveAuth({ provider, agentDir, cfg })).rejects.toMatchObject({
                  affectedProviders: ["anthropic", "nvidia"],
                });
              }
            }
          } finally {
            clearAuthProfileMigrationDiagnostics();
            clearRuntimeAuthProfileStoreSnapshots();
          }
        },
      );
    },
  );

  it("rejects pending credential migration through provider auth", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-entry-migration-" },
      async (state) => {
        const agentDir = state.agentDir("worker");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(path.join(agentDir, "auth-profiles.json"), "{}\n");
        await expect(
          resolveAuth({
            provider: "custom-provider",
            agentDir,
            cfg: configForProviders({
              "custom-provider": providerEntry("https://provider.example.test/v1", {
                apiKey: "custom-provider:prepared",
              }),
            }),
            store: authStore({
              "custom-provider:prepared": keyCredential("custom-provider", "prepared-key"),
            }),
          }).finally(() => clearAuthProfileMigrationDiagnostics()),
        ).rejects.toMatchObject({
          code: "AUTH_PROFILE_MIGRATION_REQUIRED",
          action: "openclaw doctor --fix",
        });
      },
    );
  });

  it("rejects a retired profile reference before resolving its copied credential through provider auth", async () => {
    await expect(
      resolveAuth({
        provider: "anthropic",
        cfg: configForProviders({
          anthropic: providerEntry("https://api.anthropic.com", {
            api: "anthropic-messages",
            apiKey: "anthropic:claude-cli",
          }),
        }),
        store: authStore({
          "anthropic:claude-cli": {
            type: "oauth",
            provider: "anthropic",
            access: "copied-native-access",
            refresh: "copied-native-refresh",
            expires: Date.now() + 30 * 60 * 1000,
          },
        }),
      }),
    ).rejects.toThrow(/anthropic:claude-cli.*retired.*doctor --fix/);
  });

  it("does not treat env SecretRef ids as profile references", async () => {
    await withEnvAsync({ OPENROUTER_PROFILE: "sk-or-env-secret" }, async () => {
      const resolved = await resolveAuth({
        provider: "openrouter-minimax",
        cfg: configForProviders({
          "openrouter-minimax": providerEntry("https://openrouter.ai/api/v1", {
            api: "openai-completions" as const,
            apiKey: secretRef("env", "OPENROUTER_PROFILE", "default"),
          }),
        }),
        store: authStore({
          OPENROUTER_PROFILE: keyCredential("openrouter", "sk-or-wrong-profile"),
        }),
      });

      expect(resolved.apiKey).toBe("sk-or-env-secret");
      expect(resolved.source).toContain("OPENROUTER_PROFILE");
    });
  });

  it("keeps env-first precedence ahead of stale inline cooldown for per-entry profile references", async () => {
    const usageId = resolveInlineProviderApiKeyUsageId("openai");
    await withEnvAsync({ OPENAI_API_KEY: "sk-env-first" }, async () => {
      const store = {
        version: 1 as const,
        profiles: {
          "openai:key-b": keyCredential("openai" as const, "sk-profile-key"),
        },
        usageStats: {
          [usageId]: {
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing" as const,
          },
        },
      };
      const cfg: OpenClawConfig = configForProviders({
        openai: providerEntry("https://api.openai.com/v1", {
          api: "openai-completions",
          apiKey: "openai:key-b",
        }),
      });

      const resolved = await resolveAuth({
        provider: "openai",
        credentialPrecedence: "env-first",
        cfg,
        store,
      });

      expect(resolved.apiKey).toBe("sk-env-first");
      expect(resolved.source).toContain("OPENAI_API_KEY");
      await expect(hasAuth({ provider: "openai", store, cfg })).resolves.toBe(true);
    });
  });

  it("resolves profile reference even when provider sets auth: api-key explicitly (regression for clawsweeper P3)", async () => {
    // Regression: explicit API-key mode must not send the profile ID as the bearer.
    const resolved = await resolveAuth({
      provider: "openrouter-minimax",
      cfg: {
        ...configForProviders({
          openrouter: providerEntry("https://openrouter.ai/api/v1", {
            api: "openai-completions" as const,
          }),
          "openrouter-minimax": providerEntry("https://openrouter.ai/api/v1", {
            api: "openai-completions" as const,
            apiKey: "openrouter:key-b",
            auth: "api-key" as const,
          }),
        }),
        auth: { order: { openrouter: ["openrouter:key-a", "openrouter:key-b"] } },
      },
      store: authStore({
        "openrouter:key-a": keyCredential("openrouter", "sk-or-key-a"),
        "openrouter:key-b": keyCredential("openrouter", "sk-or-actual-key-b"),
      }),
    });

    expect(resolved.apiKey).toBe("sk-or-actual-key-b");
    expect(resolved.profileId).toBe("openrouter:key-b");
    expect(resolved.source).toBe("profile:openrouter:key-b");
  });

  it("applies model auth-mode guards to per-entry token profile references through provider auth", async () => {
    await expect(
      resolveAuth({
        provider: "openai",
        modelApi: "openai-responses",
        cfg: configForProviders({
          openai: providerEntry("https://api.openai.com/v1", {
            api: "openai-responses" as const,
            apiKey: "openai:token",
          }),
        }),
        store: authStore({
          "openai:token": {
            type: "token",
            provider: "openai",
            token: "oauth-token",
          },
        }),
      }),
    ).rejects.toThrow(/requires an OpenAI API key profile/);
  });

  it.each<{
    name: string;
    provider: string;
    baseUrl: string;
    profileId: string;
    credential: AuthProfileCredential;
    error: RegExp;
  }>([
    {
      name: "OAuth credential class",
      provider: "openrouter-minimax",
      baseUrl: "https://openrouter.ai/api/v1",
      profileId: "google:oauth-a",
      credential: {
        type: "oauth",
        provider: "google",
        access: "oauth-access",
        refresh: "oauth-refresh",
        expires: 0,
      },
      error:
        /references a "oauth" credential for provider "google", which is not a bearer-style auth class/,
    },
    {
      name: "different provider endpoint",
      provider: "custom-proxy",
      baseUrl: "https://example.invalid/v1",
      profileId: "openrouter:key-b",
      credential: keyCredential("openrouter", "sk-or-actual-key-b"),
      error: /not compatible with this provider entry's auth binding/,
    },
    {
      name: "profile with no key material",
      provider: "openrouter-minimax",
      baseUrl: "https://openrouter.ai/api/v1",
      profileId: "openrouter:key-b",
      credential: { type: "api_key", provider: "openrouter" },
      error: /matched a stored profile but failed to resolve/,
    },
  ])(
    "rejects $name instead of sending a profile ID as a literal bearer",
    async ({ provider, baseUrl, profileId, credential, error }) => {
      await expect(
        resolveAuth({
          provider,
          cfg: configForProviders({
            ...(credential.type === "oauth"
              ? {}
              : {
                  openrouter: providerEntry("https://openrouter.ai/api/v1", {
                    api: "openai-completions",
                  }),
                }),
            [provider]: providerEntry(baseUrl, { api: "openai-completions", apiKey: profileId }),
          }),
          store: authStore({ [profileId]: credential }),
        }),
      ).rejects.toThrow(error);
    },
  );
});
