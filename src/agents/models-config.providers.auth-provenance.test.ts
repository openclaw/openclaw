import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPluginCatalog } from "../plugins/provider-catalog.types.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";

type ProviderRuntimeModule = typeof import("../plugins/provider-runtime.js");
const discovery = vi.hoisted(() => ({
  providers: new Array<ProviderPlugin>(),
  syntheticAuth: vi.fn<ProviderRuntimeModule["resolveProviderSyntheticAuthWithPlugin"]>(),
}));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: (params: { context?: { providerConfig?: object } }) =>
    params.context?.providerConfig,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: discovery.syntheticAuth,
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({ "proof-alias": "openai" }),
  resolveProviderIdForAuth: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return normalized === "proof-alias" ? "openai" : normalized;
  },
}));

let createProviderApiKeyResolver: typeof import("./models-config.providers.secrets.js").createProviderApiKeyResolver;
let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;

beforeAll(async () => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  ({ createProviderApiKeyResolver, createProviderAuthResolver } =
    await import("./models-config.providers.secrets.js"));
});

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  discovery.syntheticAuth.mockReset().mockReturnValue(undefined);
});

function catalogProvider(
  id: string,
  run: ProviderPluginCatalog["run"],
  metadata: Partial<Pick<ProviderPlugin, "label" | "pluginId">> = {},
): ProviderPlugin {
  return { id, label: id, auth: [], catalog: { order: "simple", run }, ...metadata };
}

const ref = (id: string, source: "env" | "store" = "env") =>
  ({ source, provider: "default", id }) as const;
const oauth = (provider: string, access: string, expires = 4_102_444_800_000) =>
  ({ type: "oauth", provider, access, refresh: "unused-refresh", expires }) as const;
type ProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];
const providerConfig = (
  baseUrl: string,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig => ({ baseUrl, models: [], ...overrides });
const configWithKey = (apiKey: ProviderConfig["apiKey"]): OpenClawConfig => ({
  models: { providers: { openai: providerConfig("https://catalog.example.test/v1", { apiKey }) } },
});
const configRef = ref("CONFIG_KEY", "store");
const emptyStore = createAuthProfileStoreFixture({});

describe("models-config provider auth provenance", () => {
  type DiscoveryCallback = "resolveProviderAuth" | "resolveProviderApiKey";

  async function createDiscoveryFixture(
    type: "api_key" | "token" = "api_key",
    callback: DiscoveryCallback = "resolveProviderAuth",
    requestedProvider = " OPENAI ",
    refSource: "store" | "env" = "store",
  ) {
    const stateDir = useAutoCleanupTempDirTracker(onTestFinished).make("discovery-ref-provenance-");
    const previousEnv = captureEnv(["OPENCLAW_STATE_DIR", "OPENAI_API_KEY"]);
    onTestFinished(() => previousEnv.restore());
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENAI_API_KEY");
    prepareSharedAuthStoreOwnershipForNative();
    const { resolveImplicitProviders } = await import("./models-config.providers.implicit.js");
    const { planOpenClawModelsJson } = await import("./models-config.plan.js");
    const { clearRuntimeAuthProfileStoreSnapshots, setRuntimeAuthProfileStoreSnapshot } =
      await import("./auth-profiles/runtime-snapshots.js");
    const { setActiveDegradedSecretOwners } = await import("../secrets/runtime-degraded-state.js");
    onTestFinished(() => {
      clearRuntimeAuthProfileStoreSnapshots();
      setActiveDegradedSecretOwners([]);
      discovery.providers = [];
    });
    const { resolveAuthProfileSecretOwnerId } =
      await import("../secrets/runtime-auth-profile-owner.js");
    const { fetchLiveProviderModelIds } =
      await import("../plugin-sdk/provider-catalog-live-runtime.js");
    const provider = "openai";
    const profileId = `${provider}:selected`;
    const agentDir = path.join(stateDir, "agent");
    const secretRef = ref("DISCOVERY_KEY", refSource);
    const profile: AuthProfileCredential =
      type === "api_key"
        ? { type, provider, keyRef: secretRef, key: "stale-inline-key" }
        : { type, provider, tokenRef: secretRef, token: "stale-inline-token" };
    const store: AuthProfileStore = { version: 1, profiles: { [profileId]: profile } };
    const runtimeKey = "runtime-discovery-key";
    const published: AuthProfileStore = createAuthProfileStoreFixture({
      [profileId]:
        profile.type === "api_key"
          ? { ...profile, key: runtimeKey }
          : { ...profile, token: runtimeKey },
    });
    const authorization: Array<string | null> = [];
    const authResults: Array<{ apiKey?: string; discoveryApiKey?: string }> = [];
    const outcomes: import("../plugins/provider-catalog.types.js").ProviderCatalogOutcome[] = [];
    const errors: unknown[] = [];
    const env: NodeJS.ProcessEnv = {};
    let emitProfileOutcome = false;
    discovery.providers = [
      catalogProvider(
        provider,
        async (ctx) => {
          try {
            const auth = ctx[callback](requestedProvider);
            authResults.push(auth);
            await fetchLiveProviderModelIds({
              providerId: provider,
              endpoint: "https://catalog.example.test/v1/models",
              ...auth,
              fetchGuard: async ({ url, init }) => {
                authorization.push(new Headers(init?.headers).get("authorization"));
                return {
                  response: Response.json({ data: [{ id: "test-model" }] }),
                  finalUrl: url,
                  release: async () => {},
                };
              },
            });
            return {
              provider: providerConfig("https://catalog.example.test/v1", { apiKey: auth.apiKey }),
              outcomes:
                emitProfileOutcome && auth.profileId
                  ? [{ provider, profileId: auth.profileId, status: "ready" as const }]
                  : undefined,
            };
          } catch (error) {
            errors.push(error);
            throw error;
          }
        },
        { label: "a requested provider" },
      ),
      catalogProvider(
        "healthy",
        async () => ({ provider: providerConfig("https://healthy.example.test") }),
        { label: "z independent provider" },
      ),
    ];
    const publish = (directory = agentDir) =>
      setRuntimeAuthProfileStoreSnapshot(published, directory);
    publish();
    const context = {
      agentDir,
      env,
      onProviderCatalogOutcome: (outcome: (typeof outcomes)[number]) => outcomes.push(outcome),
    };

    return {
      store,
      published,
      profileId,
      agentDir,
      runtimeKey,
      env,
      setKey: (id: string, key: string) => {
        store.profiles[id] = createApiKeyCredential(provider, key);
      },
      pin: (credential: AuthProfileCredential) => {
        store.profiles = {
          "openai:other": createApiKeyCredential(provider, "must-not-fall-back"),
          [profileId]: credential,
        };
        store.order = { openai: ["openai:other", profileId] };
      },
      publish,
      clear: clearRuntimeAuthProfileStoreSnapshots,
      cold: () =>
        setActiveDegradedSecretOwners([
          {
            ownerKind: "account",
            ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
            state: "unavailable",
            degradationState: "cold",
            paths: [],
            refKeys: [],
            reason: "secret reference was not found",
          },
        ]),
      discover: (config: OpenClawConfig = {}) =>
        resolveImplicitProviders({ ...context, authStore: store, config }),
      emitOutcome: () => {
        emitProfileOutcome = true;
      },
      plan: (source: OpenClawConfig = {}, prepared = source) =>
        planOpenClawModelsJson({
          context: {
            ...context,
            cfg: source,
            discoveryAuthConfig: prepared,
            sourceConfigForSecrets: source,
            envFingerprint: env,
          },
          authStore: store,
          existingRaw: "",
          existingParsed: null,
        }),
      authorization,
      authResults,
      outcomes,
      expectHttp: (...keys: string[]) => {
        expect(authorization).toEqual(keys.map((key) => `Bearer ${key}`));
        expect(errors).toEqual([]);
      },
      expectOutcome: (status: "ready" | "unavailable" = "ready", id: string | null = profileId) =>
        expect(outcomes).toEqual([{ provider, ...(id ? { profileId: id } : {}), status }]),
      expectAuth: (expected: object) =>
        expect(authResults).toEqual([expect.objectContaining(expected)]),
      expectBlocked: (errorType?: new (...args: never[]) => Error) => {
        expect(authorization).toEqual([]);
        expect(errors).toHaveLength(1);
        if (errorType) {
          expect(errors[0]).toBeInstanceOf(errorType);
        }
      },
    };
  }

  it.each([
    { type: "api_key", callback: "resolveProviderAuth", refSource: "store" },
    { type: "token", callback: "resolveProviderApiKey", refSource: "env" },
  ] as const)(
    "authenticates published $refSource-backed $type discovery through $callback",
    async ({ type, callback, refSource }) => {
      const f = await createDiscoveryFixture(type, callback, "proof-alias", refSource);
      const marker = refSource === "env" ? "DISCOVERY_KEY" : NON_ENV_SECRETREF_MARKER;
      if (callback === "resolveProviderAuth") {
        f.env.OPENAI_API_KEY = "unselected-env-key";
      }
      f.emitOutcome();
      const providers = await f.discover();
      expect(providers?.openai?.apiKey).toBe(marker);
      f.expectOutcome();
      expect(JSON.stringify(providers)).not.toContain(f.runtimeKey);
      expect(f.authorization).toEqual([`Bearer ${f.runtimeKey}`]);
      const plan = await f.plan();
      expect(plan.action).toBe("write");
      expect(JSON.stringify(plan)).toContain(marker);
      expect(JSON.stringify(plan)).not.toMatch(/runtime-discovery-key|stale-inline/);
    },
  );

  it.each([
    ["api_key", "agent-mismatch"],
    ["api_key", "provider-mismatch"],
    ["api_key", "ref-mismatch"],
    ["token", "missing-value"],
    ["api_key", "cleared"],
    ["api_key", "cold"],
  ] as const)("isolates %s %s without fallback or anonymous HTTP", async (type, state) => {
    const refSource = state === "cold" ? "env" : "store";
    const f = await createDiscoveryFixture(type, "resolveProviderAuth", "openai", refSource);
    const { SecretSurfaceUnavailableError } = await import("../secrets/runtime-degraded-state.js");
    f.setKey("openai:other", "wrong-account-key");
    const profile = expectDefined(f.published.profiles[f.profileId], "published profile");
    if (state === "cleared") {
      await f.discover();
      expect(f.authorization).toEqual([`Bearer ${f.runtimeKey}`]);
      f.authorization.length = 0;
      f.clear();
    }
    if (state === "agent-mismatch") {
      f.clear();
      f.publish(path.join(f.agentDir, "other"));
    }
    if (state === "provider-mismatch") {
      profile.provider = "other-provider";
    }
    if (state === "ref-mismatch" && profile.type === "api_key") {
      profile.keyRef = ref("OTHER_KEY", "store");
    }
    if (state === "missing-value" && profile.type === "token") {
      delete profile.token;
    }
    if (state !== "cleared" && state !== "agent-mismatch") {
      f.publish();
    }
    if (state === "cold") {
      f.cold();
    }
    // Profile-first resolution must not escape to otherwise valid ambient auth.
    f.env.OPENAI_API_KEY = "wrong-env-key";
    const providers = await f.discover();
    f.expectBlocked(SecretSurfaceUnavailableError);
    f.expectOutcome("unavailable");
    expect(providers?.openai).toBeUndefined();
    expect(providers?.healthy).toBeDefined();
    expect(JSON.stringify([providers, f.outcomes])).not.toMatch(
      /stale-inline|wrong-account-key|wrong-env-key|runtime-discovery-key/,
    );
  });

  it("skips expired profiles through resolveProviderAuth and uses the next canonical candidate", async () => {
    const f = await createDiscoveryFixture("token");
    const selected = expectDefined(f.store.profiles[f.profileId], "selected profile");
    if (selected.type !== "token") {
      throw new Error("expected token profile");
    }
    selected.expires = 1;
    f.setKey("openai:fallback", "eligible-fallback-key");

    await f.discover();

    f.expectHttp("eligible-fallback-key");
  });

  it.each([undefined, "chatgpt-identity"])(
    "uses OAuth discovery credentials with auth flow %s",
    async (authFlow) => {
      const f = await createDiscoveryFixture();
      f.store.profiles[f.profileId] = {
        ...oauth("openai", "oauth-key", Date.now() + 600_000),
        authFlow,
      };
      await f.discover();
      f.expectHttp("oauth-key");
      f.expectAuth({
        mode: "oauth",
        discoveryApiKey: "oauth-key",
        ...(authFlow ? { authFlow } : {}),
      });
    },
  );

  it("uses cold env refs without a published auth snapshot", async () => {
    const f = await createDiscoveryFixture();
    f.clear();
    f.store.profiles[f.profileId] = {
      type: "api_key",
      provider: "openai",
      keyRef: ref("PROFILE_KEY"),
    };
    f.env.PROFILE_KEY = "env-ref-key";
    await f.discover();
    f.expectHttp("env-ref-key");
  });

  it("prefers ambient auth and ignores unselected failures through resolveProviderApiKey", async () => {
    const f = await createDiscoveryFixture("api_key", "resolveProviderApiKey");
    f.env.OPENAI_API_KEY = "ambient-key";
    f.store.profiles["openai:unselected"] = {
      type: "api_key",
      provider: "openai",
      keyRef: ref("UNPUBLISHED", "store"),
    };
    f.store.profiles["unrelated:oauth"] = {
      ...oauth("unrelated", "expired", 1),
      refresh: "must-not-refresh",
    };
    const resolveProfile = vi.spyOn(
      await import("./auth-profiles/oauth.js"),
      "resolveApiKeyForProfile",
    );
    try {
      await f.discover();
      await f.plan(configWithKey(configRef));
      f.expectHttp("ambient-key", "ambient-key");
      expect(resolveProfile.mock.calls.map(([params]) => params.profileId)).not.toContain(
        "unrelated:oauth",
      );
      expect(f.outcomes).toEqual([]);
    } finally {
      resolveProfile.mockRestore();
    }
  });

  it.each([
    ["stored order", undefined, false],
    ["model cooldown", "gpt-5.5", true],
    ["profile cooldown", undefined, false],
  ] as const)(
    "applies %s during catalog discovery through resolveProviderAuth",
    async (scope, cooldownModel, keepPrimary) => {
      const f = await createDiscoveryFixture();
      const backupProfileId = "openai:backup";
      f.setKey(backupProfileId, "backup-key");
      if (scope === "stored order") {
        f.store.order = { openai: [backupProfileId, f.profileId] };
      } else {
        f.store.usageStats = {
          [f.profileId]: {
            cooldownReason: "rate_limit",
            cooldownUntil: Date.now() + 60_000,
            ...(cooldownModel ? { cooldownModel } : {}),
          },
        };
      }
      f.emitOutcome();
      await f.discover({
        auth: { order: { openai: [f.profileId, backupProfileId] } },
      });
      expect(f.authorization).toEqual([`Bearer ${keepPrimary ? f.runtimeKey : "backup-key"}`]);
      f.expectOutcome("ready", keepPrimary ? f.profileId : backupProfileId);
    },
  );

  describe.each(["resolveProviderApiKey", "resolveProviderAuth"] as const)(
    "%s configured profile references",
    (callback) => {
      it("uses the pinned credential instead of the first ordered profile", async () => {
        const f = await createDiscoveryFixture("api_key", callback);
        f.pin(createApiKeyCredential("openai", "pinned-profile-key"));

        await f.discover(configWithKey(f.profileId));

        f.expectHttp("pinned-profile-key");
        f.expectAuth({ profileId: f.profileId, discoveryApiKey: "pinned-profile-key" });
      });

      it.each<[string, AuthProfileCredential]>([
        ["another provider", createApiKeyCredential("anthropic", "wrong-provider-key")],
        ["OAuth", oauth("openai", "wrong-oauth-key")],
        ["an empty key", createApiKeyCredential("openai", "")],
        [
          "an expired token",
          { type: "token", provider: "openai", token: "expired-key", expires: 1 },
        ],
        [
          "an inactive setup replacement",
          {
            ...createApiKeyCredential("openai", "inactive-replacement-key"),
            setup: { replacement: true, modelRef: "openai/proof-model", configJson: "{}" },
          },
        ],
      ])("fails closed when the pinned profile contains %s", async (_name, credential) => {
        const f = await createDiscoveryFixture("api_key", callback);
        f.pin(credential);

        await f.discover(configWithKey(f.profileId));

        f.expectBlocked(Error);
        expect(f.authResults).toEqual([]);
      });

      it.each([
        { provider: "anthropic", mode: "api_key" },
        { provider: "openai", mode: "oauth" },
      ] as const)("rejects an incompatible configured profile %j", async (profileConfig) => {
        const f = await createDiscoveryFixture("api_key", callback);
        f.setKey(f.profileId, "must-not-use-incompatible-key");
        await f.discover({
          ...configWithKey(f.profileId),
          auth: { profiles: { [f.profileId]: profileConfig } },
        });

        f.expectBlocked();
        expect(f.authResults).toEqual([]);
      });

      it("keeps an unknown profile-shaped literal as the actual request key", async () => {
        const f = await createDiscoveryFixture("api_key", callback);
        f.store.profiles = {};

        await f.discover(configWithKey("openai:not-a-stored-profile"));

        f.expectHttp("openai:not-a-stored-profile");
      });
    },
  );

  it("does not switch profiles when the configured full-auth profile is excluded", () => {
    const profileId = "openai:pinned";
    const auth = createProviderAuthResolver(
      {},
      createAuthProfileStoreFixture({
        [profileId]: createApiKeyCredential("openai", "pinned-profile-key"),
        "openai:other": createApiKeyCredential("openai", "must-not-fall-back"),
      }),
      configWithKey(profileId),
    );

    expect(auth("openai", { excludeProfileIds: [profileId] })).toEqual({
      apiKey: undefined,
      mode: "none",
      source: "none",
    });
  });

  it("keeps ambient API-key precedence over a configured profile reference", async () => {
    const f = await createDiscoveryFixture("api_key", "resolveProviderApiKey");
    f.env.OPENAI_API_KEY = "ambient-key";
    f.setKey(f.profileId, "unselected-profile-key");

    await f.discover(configWithKey(f.profileId));

    f.expectHttp("ambient-key");
  });

  it.each([
    ["resolveProviderApiKey", "anthropic:stored", " OPENAI "],
    ["resolveProviderAuth", "anthropic:stored", " OPENAI "],
    ["resolveProviderAuth", "secretref-managed", "proof-alias"],
  ] as const)("keeps prepared %s SecretRef bytes %s opaque", async (callback, value, provider) => {
    const f = await createDiscoveryFixture("api_key", callback, provider);
    f.store.profiles =
      value === "anthropic:stored"
        ? { [value]: createApiKeyCredential("anthropic", "must-not-use-profile-key") }
        : {};
    const plan = await f.plan(configWithKey(configRef), configWithKey(value));
    f.expectAuth({ apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: value });
    f.expectHttp(value);
    expect(plan.action).toBe("write");
    expect(JSON.stringify(plan)).toContain(NON_ENV_SECRETREF_MARKER);
    expect(JSON.stringify(plan)).not.toContain("discoveryApiKey");
  });

  it("isolates selected unmaterialized config refs through resolveProviderAuth before HTTP", async () => {
    const f = await createDiscoveryFixture();
    const { SecretSurfaceUnavailableError } = await import("../secrets/runtime-degraded-state.js");
    f.store.profiles = {};
    f.env.CONFIG_KEY = "wrong-env-key";
    const plan = await f.plan(configWithKey(configRef));
    f.expectBlocked(SecretSurfaceUnavailableError);
    f.expectOutcome("unavailable", null);
    expect(JSON.stringify(plan)).toContain("healthy");
    expect(JSON.stringify(plan)).not.toMatch(/wrong-account-key|wrong-env-key/);
  });

  it.each([
    { key: "xai-plugin-key", marker: NON_ENV_SECRETREF_MARKER, discoveryApiKey: "xai-plugin-key" },
    { key: "custom-local", marker: "custom-local", discoveryApiKey: undefined },
  ])("preserves synthetic auth provenance for $key", ({ key, marker, discoveryApiKey }) => {
    discovery.syntheticAuth.mockReturnValue({
      apiKey: key,
      mode: "api-key",
      source: "test plugin",
    });
    const auth = createProviderAuthResolver({}, emptyStore);
    expect(auth("fixture")).toEqual({
      apiKey: marker,
      discoveryApiKey,
      mode: "api_key",
      source: "none",
    });
  });

  it.each([
    ["${MY_VLLM_KEY}", { MY_VLLM_KEY: "resolved-key" }, "MY_VLLM_KEY", "resolved-key"],
    ["${MY_VLLM_KEY}", {}, undefined, undefined],
    ["VLLM_API_KEY", {}, undefined, undefined],
    ["ALLCAPS_SAMPLE", {}, "ALLCAPS_SAMPLE", "ALLCAPS_SAMPLE"],
  ] as const)("resolves configured credential %s with %j", (key, env, apiKey, discoveryApiKey) => {
    const auth = createProviderApiKeyResolver(env, emptyStore, configWithKey(key));
    expect(auth("openai")).toEqual({
      apiKey,
      discoveryApiKey,
      ...(apiKey ? { mode: "api_key" } : {}),
    });
  });

  it("keeps unresolved non-env refs sterile in the pure full-auth factory", () => {
    const auth = createProviderAuthResolver({}, emptyStore, configWithKey(configRef));
    expect(auth("openai")).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: undefined,
      mode: "api_key",
      source: "none",
    });
  });

  it("keeps synthetic markers in the mixed prepared credential map transport-free", async () => {
    const { CUSTOM_LOCAL_AUTH_MARKER } = await import("./model-auth-markers.js");
    const { createProviderApiKeyResolverFromPreparedCredentials } =
      await import("./models-config.providers.secrets.js");
    for (const key of [CUSTOM_LOCAL_AUTH_MARKER, NON_ENV_SECRETREF_MARKER]) {
      const auth = createProviderApiKeyResolverFromPreparedCredentials(
        { OPENAI_API_KEY: "unselected-env" },
        { openai: { type: "api_key", key } },
      );
      expect(auth("openai")).toEqual({ apiKey: key, discoveryApiKey: undefined, mode: "api_key" });
    }
  });
});

describe("models-config catalog runtime headers", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const catalogConfig = (
    catalog: Partial<ProviderConfig>,
    other?: Partial<ProviderConfig>,
  ): OpenClawConfig => ({
    models: {
      providers: {
        "catalog-fixture": providerConfig("https://catalog.example/v1", catalog),
        ...(other ? { "other-fixture": providerConfig("https://other.example/v1", other) } : {}),
      },
    },
  });
  const setCatalog = (run: ProviderPluginCatalog["run"]) => {
    discovery.providers = [
      catalogProvider("catalog-fixture", run, {
        pluginId: "catalog-fixture",
        label: "Catalog fixture",
      }),
    ];
  };
  async function planCatalog(
    cfg: OpenClawConfig,
    runtime: OpenClawConfig,
    env: NodeJS.ProcessEnv = {},
  ) {
    const { planOpenClawModelsJson } = await import("./models-config.plan.js");
    return planOpenClawModelsJson({
      context: {
        cfg,
        discoveryAuthConfig: runtime,
        sourceConfigForSecrets: cfg,
        agentDir: tempDirs.make("catalog-headers-"),
        env,
        envFingerprint: "catalog-headers",
        providerDiscoveryProviderIds: ["catalog-fixture"],
      },
      authStore: emptyStore,
      existingRaw: "",
      existingParsed: null,
    });
  }

  it("passes resolved catalog headers while persisting their source markers", async () => {
    const sourceConfig = catalogConfig(
      {
        api: "openai-completions",
        apiKey: ref("CATALOG_AUTH_TOKEN"),
        headers: { "X-Catalog-Token": ref("CATALOG_TOP_TOKEN") },
        request: { headers: { "X-Request-Token": ref("CATALOG_REQUEST_TOKEN") } },
      },
      { headers: { "X-Other-Token": ref("CATALOG_OTHER_TOKEN") } },
    );
    const runtimeConfig = catalogConfig(
      {
        api: "openai-completions",
        apiKey: "activated-auth-material",
        headers: { "X-Catalog-Token": "activated-catalog-material" },
        request: { headers: { "X-Request-Token": "activated-request-material" } },
      },
      { headers: { "X-Other-Token": "other-private-material" } },
    );
    const before = structuredClone(sourceConfig);
    const observed: unknown[] = [];
    setCatalog(async (ctx) => {
      const provider = expectDefined(
        ctx.config.models?.providers?.["catalog-fixture"],
        "catalog callback provider",
      );
      observed.push({
        apiKey: provider.apiKey,
        headers: provider.headers,
        request: provider.request,
        otherHeaders: ctx.config.models?.providers?.["other-fixture"]?.headers,
      });
      return { provider: { baseUrl: provider.baseUrl, api: provider.api, models: [] } };
    });
    const plan = await planCatalog(sourceConfig, runtimeConfig, {
      CATALOG_TOP_TOKEN: "unactivated-env-material",
    });

    expect(observed).toEqual([
      {
        apiKey: ref("CATALOG_AUTH_TOKEN"),
        headers: { "X-Catalog-Token": "activated-catalog-material" },
        request: { headers: { "X-Request-Token": "activated-request-material" } },
        otherHeaders: { "X-Other-Token": ref("CATALOG_OTHER_TOKEN") },
      },
    ]);
    expect(plan.action).toBe("write");
    expect(JSON.stringify(plan)).toContain("CATALOG_TOP_TOKEN");
    expect(JSON.stringify(plan)).toContain("CATALOG_REQUEST_TOKEN");
    expect(JSON.stringify(plan)).not.toMatch(
      /activated-catalog-material|activated-request-material|activated-auth-material|other-private-material/,
    );
    expect(sourceConfig).toEqual(before);
  });

  it("keeps unresolved catalog headers fail-closed", async () => {
    const { normalizeResolvedSecretInputString } = await import("../config/types.secrets.js");
    const config = catalogConfig({ headers: { "X-Catalog-Token": ref("CATALOG_TOP_TOKEN") } });
    setCatalog(async (ctx) => {
      normalizeResolvedSecretInputString({
        value: ctx.config.models?.providers?.["catalog-fixture"]?.headers?.["X-Catalog-Token"],
        path: "models.providers.catalog-fixture.headers.X-Catalog-Token",
      });
      throw new Error("Unresolved catalog request was admitted");
    });

    await expect(planCatalog(config, structuredClone(config))).rejects.toThrow(
      "unresolved SecretRef",
    );
  });
});
