import fs from "node:fs/promises";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createApiKeyCredential as keyCredential,
  createAuthProfileStoreFixture as authStore,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { refreshAuthProfileFileState } from "./auth-profiles/file-state.js";
import { clearAuthProfileMigrationDiagnostics } from "./auth-profiles/legacy-source-diagnostic.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
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
  configFor,
  configForProviders,
  modelDefinition,
  providerEntry,
} from "./model-auth.fixtures.test-support.js";
import {
  createRuntimeProviderAuthLookup,
  getApiKeyForModelCore as resolveModelAuth,
  hasAvailableAuthForProvider as hasAuth,
  hasRuntimeAvailableProviderAuth,
  prepareRuntimeAvailableProviderAuth,
  resolveApiKeyForProviderCore as resolveAuth,
  resolveEnvApiKey,
} from "./model-auth.js";

const authStateOptions = {
  layout: "state-only",
  prefix: "openclaw-auth-",
  agentEnv: "main",
} as const;
function withAuthState(
  run: Parameters<typeof withOpenClawTestState>[1],
  options: Partial<Parameters<typeof withOpenClawTestState>[0]> = {},
) {
  return withOpenClawTestState({ ...authStateOptions, ...options }, run);
}

function model(id: string, api: Model["api"], extra: Partial<Model> = {}): Model {
  return { id, provider: "openai", api, ...extra } as Model;
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

// mock-isolation: Profile and environment precedence fixtures define every credential source, excluding live provider overlays.
vi.mock("../plugins/provider-external-auth-core.js", () => ({
  createProviderExternalAuthResolver: () => ({
    resolveExternalAuthProfilesWithPlugins: () => [],
    withPreparedExternalAuthProfiles: async <T>(_params: unknown, run: () => Promise<T>) => run(),
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
  prepareSharedAuthStoreOwnershipForNative();
  clearRuntimeAuthProfileStoreSnapshots();
  cliCredentialMocks.readCodexCliCredentialsCached.mockReset().mockReturnValue(null);
  cliCredentialMocks.readMiniMaxCliCredentialsCached.mockReset().mockReturnValue(null);
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const oauthFixture = {
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 30 * 60 * 1000,
  accountId: "acct_123",
};

const routerUrl = "https://openrouter.ai/api/v1";

const BEDROCK_PROVIDER_CFG = configFor(
  "amazon-bedrock",
  "https://bedrock-runtime.us-east-1.amazonaws.com",
  {
    api: "bedrock-converse-stream",
    auth: "aws-sdk",
  },
);

const BEDROCK_PROVIDER_CFG_WITH_PROFILE = {
  ...BEDROCK_PROVIDER_CFG,
  auth: {
    order: { "amazon-bedrock": ["amazon-bedrock:default"] },
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
    expect(resolved).toMatchObject({
      mode: "aws-sdk",
      profileId: "amazon-bedrock:default",
      source: "profile:amazon-bedrock:default",
    });
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

function buildDemoLocalProviderCfg(apiKey: string) {
  return configFor("demo-local", "https://local-provider.example", {
    api: "openai-completions",
    apiKey,
  });
}

it.each([
  ["shared read-through", "shared-state-key", false, undefined],
  ["legacy main authority", "legacy-main-key", true, undefined],
  ["agent-local override", "shared-state-key", false, "agent-local-key"],
] as const)("preserves %s", async (_name, baseKey, legacy, localKey) => {
  await withAuthState(
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
      const resolved = await resolveAuth({ provider: "openai", cfg: {}, agentDir, store });

      expect(resolved).toMatchObject({
        apiKey: localKey ?? baseKey,
        source: `profile:${profileId}`,
      });
    },
    { env: { OPENAI_API_KEY: undefined } },
  );
});

describe("getApiKeyForModelCore", () => {
  it("keeps OpenAI OAuth profiles on the Codex transport and API keys on direct OpenAI", async () => {
    await withAuthState(async (state) => {
      setRuntimeConfigSnapshot({});
      await state.writeAuthProfiles(
        authStore({
          "openai:chatgpt": createOAuthRefreshCredential(oauthFixture),
          "openai:api-key": keyCredential("openai", "direct-openai-key"),
        }),
      );
      const agentDir = state.agentDir();
      const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });

      const directAuth = await resolveModelAuth({
        model: model("chat-latest", "openai-responses"),
        store,
        agentDir,
      });
      const codexAuth = await resolveModelAuth({
        model: model("gpt-5.5", "openai-chatgpt-responses"),
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
    });
  });

  it("resolves ChatGPT token-sharing as renewable OAuth for public Responses", async () => {
    setRuntimeConfigSnapshot({});
    await expect(
      resolveModelAuth({
        model: model("gpt-5.5", "openai-responses", { baseUrl: "https://api.openai.com/v1" }),
        profileId: "openai:shared",
        lockedProfile: true,
        store: authStore({
          "openai:shared": createOAuthRefreshCredential({
            ...oauthFixture,
            authFlow: "chatgpt-token-sharing",
          }),
        }),
      }),
    ).resolves.toMatchObject({
      apiKey: oauthFixture.access,
      mode: "oauth",
      authFlow: "chatgpt-token-sharing",
      profileId: "openai:shared",
    });
  });

  it("rejects an explicit OpenAI API-key profile for the Codex transport", async () => {
    const store = authStore({
      "openai:api-key": keyCredential("openai", "direct-openai-key"),
    });

    await expect(
      resolveModelAuth({
        model: model("gpt-5.5", "openai-chatgpt-responses"),
        profileId: "openai:api-key",
        lockedProfile: true,
        store,
      }),
    ).rejects.toThrow(/requires a ChatGPT subscription \(OAuth or token\) profile/);
  });

  it("uses the config default agent dir for inline provider cooldown checks", async () => {
    await withAuthState(
      async (state) => {
        await state.writeAuthProfiles(cooldownStore("demo-local"), "configured");

        const cfg: OpenClawConfig = {
          ...buildDemoLocalProviderCfg("DEMO_LOCAL_API_KEY"),
          agents: { entries: { configured: { agentDir: state.agentDir("configured") } } },
        };

        await withEnvAsync({ DEMO_LOCAL_API_KEY: "env-demo-key" }, async () => {
          await expect(resolveAuth({ provider: "demo-local", cfg })).rejects.toThrow(
            /Inline API key for provider "demo-local" is temporarily disabled/,
          );
        });
      },
      { agentEnv: "clear" },
    );
  });

  it("does not read unrelated external CLI credentials when resolving provider auth", async () => {
    await withAuthState(
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
      { env: { OPENAI_API_KEY: undefined } },
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
            models: [
              modelDefinition("fixture-model", { reasoning: false, contextWindow: 128_000 }),
            ],
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
        const cfg = configFor("inline-cloud", "https://inline-cloud.example", {
          api: "openai-completions",
          apiKey: "INLINE_CLOUD_API_KEY",
        });
        await expect(hasAuth({ provider: "inline-cloud", store, cfg })).resolves.toBe(healthy);
        if (healthy) {
          expect(await resolveAuth({ provider: "inline-cloud", store, cfg })).toMatchObject({
            apiKey: "stored-cloud-key",
            source: "profile:inline-cloud:default",
          });
        } else {
          await expect(resolveAuth({ provider: "inline-cloud", store, cfg })).rejects.toThrow(
            /Inline API key for provider "inline-cloud" is temporarily disabled/,
          );
        }
      });
    },
  );

  it.each([undefined, "env-demo-key"])(
    "defers synthetic profiles to real auth: %s",
    async (envApiKey) => {
      await withEnvAsync({ DEMO_LOCAL_API_KEY: envApiKey }, async () => {
        const resolved = await resolveAuth({
          provider: "demo-local",
          store: buildDemoLocalStore(envApiKey ? ["demo-local", "demo-local"] : ["demo-local"]),
          cfg: buildDemoLocalProviderCfg("DEMO_LOCAL_API_KEY"),
        });
        expect(resolved.apiKey).toBe(envApiKey ?? "demo-local");
        expect(resolved.profileId).toBe(envApiKey ? undefined : "demo-local:default");
        if (envApiKey) {
          expect(resolved.source).toContain("DEMO_LOCAL_API_KEY");
        } else {
          expect(resolved.source).toBe("profile:demo-local:default");
        }
      });
    },
  );

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

  it.each([false, true])("honors the explicit ADC path (missing: %s)", async (missing) => {
    const homeDir = tempDirs.make("openclaw-google-adc-");
    const credentialsPath = path.join(homeDir, missing ? "missing-adc.json" : "認証情報-adc.json");
    if (missing) {
      const fallbackDir = path.join(homeDir, ".config", "gcloud");
      await fs.mkdir(fallbackDir, { recursive: true });
      await fs.writeFile(path.join(fallbackDir, "application_default_credentials.json"), "{}");
    } else {
      await fs.writeFile(credentialsPath, "{}");
    }
    const resolved = resolveEnvApiKey(
      "google-vertex",
      {
        GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
        GOOGLE_CLOUD_LOCATION: "us-central1",
        GOOGLE_CLOUD_PROJECT: "vertex-project",
        ...(missing ? { HOME: homeDir } : {}),
      },
      missing ? undefined : { candidateMap: { "google-vertex": ["GOOGLE_CLOUD_API_KEY"] } },
    );
    if (missing) {
      expect(resolved).toBeNull();
    } else {
      expect(resolved).toMatchObject({ apiKey: "gcp-vertex-credentials", source: "gcloud adc" });
    }
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
      await withAuthState(
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
                await refreshAuthProfileFileState();
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
        { agentEnv: undefined },
      );
    },
  );
  it("rejects pending credential migration through provider auth", async () => {
    await withAuthState(
      async (state) => {
        const agentDir = state.agentDir("worker");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(path.join(agentDir, "auth-profiles.json"), "{}\n");
        await expect(
          resolveAuth({
            provider: "custom-provider",
            agentDir,
            cfg: configFor("custom-provider", "https://provider.example.test/v1", {
              apiKey: "custom-provider:prepared",
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
      { agentEnv: undefined },
    );
  });

  it("does not treat env SecretRef ids as profile references", async () => {
    await withEnvAsync({ OPENROUTER_PROFILE: "sk-or-env-secret" }, async () => {
      const resolved = await resolveAuth({
        provider: "openrouter-minimax",
        cfg: configFor("openrouter-minimax", "https://openrouter.ai/api/v1", {
          api: "openai-completions" as const,
          apiKey: { source: "env", provider: "default", id: "OPENROUTER_PROFILE" },
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
    await withEnvAsync({ OPENAI_API_KEY: "sk-env-first" }, async () => {
      const store = cooldownStore("openai", {
        "openai:key-b": keyCredential("openai" as const, "sk-profile-key"),
      });
      const cfg = configFor("openai", "https://api.openai.com/v1", {
        api: "openai-completions",
        apiKey: "openai:key-b",
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

    expect(resolved).toMatchObject({
      apiKey: "sk-or-actual-key-b",
      profileId: "openrouter:key-b",
      source: "profile:openrouter:key-b",
    });
  });

  type BindingOptions = Partial<Pick<ModelProviderConfig, "baseUrl" | "api">> & {
    provider?: string;
    profileId?: string;
    modelApi?: string;
    owner?: boolean;
  };
  it.each<[string, AuthProfileCredential, RegExp, BindingOptions?]>([
    [
      "retired profile",
      createOAuthRefreshCredential({ provider: "anthropic" }),
      /anthropic:claude-cli.*retired.*doctor --fix/,
      {
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        profileId: "anthropic:claude-cli",
      },
    ],
    [
      "model auth mode",
      { type: "token", provider: "openai", token: "oauth-token" },
      /requires an OpenAI API key profile/,
      {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        profileId: "openai:token",
        api: "openai-responses",
        modelApi: "openai-responses",
        owner: false,
      },
    ],
    [
      "OAuth credential class",
      createOAuthRefreshCredential({ provider: "google", expires: 0 }),
      /references a "oauth" credential for provider "google", which is not a bearer-style auth class/,
      { profileId: "google:oauth-a" },
    ],
    [
      "different provider endpoint",
      keyCredential("openrouter", "sk-or-actual-key-b"),
      /not compatible with this provider entry's auth binding/,
      { provider: "custom-proxy", baseUrl: "https://example.invalid/v1" },
    ],
    [
      "profile with no key material",
      { type: "api_key", provider: "openrouter" },
      /matched a stored profile but failed to resolve/,
    ],
  ])(
    "rejects %s instead of sending a profile ID as a literal bearer",
    async (_name, credential, error, options = {}) => {
      const {
        provider = "openrouter-minimax",
        baseUrl = routerUrl,
        profileId = "openrouter:key-b",
        api = "openai-completions",
        modelApi,
        owner = credential.type !== "oauth",
      } = options;
      await expect(
        resolveAuth({
          provider,
          modelApi,
          cfg: configForProviders({
            ...(owner
              ? { openrouter: providerEntry(routerUrl, { api: "openai-completions" }) }
              : {}),
            [provider]: providerEntry(baseUrl, { api, apiKey: profileId }),
          }),
          store: authStore({ [profileId]: credential }),
        }),
      ).rejects.toThrow(error);
    },
  );
});
