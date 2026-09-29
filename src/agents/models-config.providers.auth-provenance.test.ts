// Verifies persisted provider auth markers preserve credential provenance.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential, AuthProfileStore } from "./auth-profiles/types.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: (params: { context?: { providerConfig?: object } }) =>
    params.context?.providerConfig,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({ "proof-alias": "openai" }),
  resolveProviderIdForAuth: (provider: string) => {
    const normalized = provider.trim().toLowerCase();
    return normalized === "proof-alias" ? "openai" : normalized;
  },
}));

type ProviderRuntimeModule = typeof import("../plugins/provider-runtime.js");

let CUSTOM_LOCAL_AUTH_MARKER: typeof import("./model-auth-markers.js").CUSTOM_LOCAL_AUTH_MARKER;
let createProviderApiKeyResolver: typeof import("./models-config.providers.secrets.js").createProviderApiKeyResolver;
let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;
let mockedResolveProviderSyntheticAuthWithPlugin: ReturnType<
  typeof vi.mocked<ProviderRuntimeModule["resolveProviderSyntheticAuthWithPlugin"]>
>;

async function loadProviderAuthModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  const [providerRuntimeModule, markersModule, secretsModule] = await Promise.all([
    import("../plugins/provider-runtime.js"),
    import("./model-auth-markers.js"),
    import("./models-config.providers.secrets.js"),
  ]);
  mockedResolveProviderSyntheticAuthWithPlugin = vi.mocked(
    providerRuntimeModule.resolveProviderSyntheticAuthWithPlugin,
  );
  CUSTOM_LOCAL_AUTH_MARKER = markersModule.CUSTOM_LOCAL_AUTH_MARKER;
  createProviderApiKeyResolver = secretsModule.createProviderApiKeyResolver;
  createProviderAuthResolver = secretsModule.createProviderAuthResolver;
}

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  mockedResolveProviderSyntheticAuthWithPlugin.mockReset().mockReturnValue(undefined);
});

beforeAll(loadProviderAuthModules);

describe("models-config provider auth provenance", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  type DiscoveryCallback = "resolveProviderAuth" | "resolveProviderApiKey";

  async function createDiscoveryFixture(
    stateDir: string,
    type: "api_key" | "token",
    callback: DiscoveryCallback,
    requestedProvider: string,
    refSource: "store" | "env",
  ) {
    const { resolveImplicitProviders } = await import("./models-config.providers.implicit.js");
    const { planOpenClawModelsJson } = await import("./models-config.plan.js");
    const { clearRuntimeAuthProfileStoreSnapshots, setRuntimeAuthProfileStoreSnapshot } =
      await import("./auth-profiles/runtime-snapshots.js");
    const { setActiveDegradedSecretOwners } = await import("../secrets/runtime-degraded-state.js");
    const { resolveAuthProfileSecretOwnerId } =
      await import("../secrets/runtime-auth-profile-owner.js");
    const { fetchLiveProviderModelIds } =
      await import("../plugin-sdk/provider-catalog-live-runtime.js");
    const provider = "openai";
    const profileId = `${provider}:selected`;
    const agentDir = path.join(stateDir, "agent");
    const ref = { source: refSource, provider: "default", id: "DISCOVERY_KEY" } as const;
    const profile: AuthProfileCredential =
      type === "api_key"
        ? { type, provider, keyRef: ref, key: "stale-inline-key" }
        : { type, provider, tokenRef: ref, token: "stale-inline-token" };
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
    const outcomes: Array<import("../plugins/provider-catalog.types.js").ProviderCatalogOutcome> =
      [];
    const errors: unknown[] = [];
    const env: NodeJS.ProcessEnv = {};
    let emitProfileOutcome = false;
    discovery.providers = [
      {
        id: provider,
        label: "a requested provider",
        auth: [],
        catalog: {
          order: "simple",
          run: async (ctx) => {
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
              const result = {
                provider: {
                  apiKey: auth.apiKey,
                  baseUrl: "https://catalog.example.test/v1",
                  models: [],
                },
              };
              const selectedProfileId =
                "profileId" in auth && typeof auth.profileId === "string"
                  ? auth.profileId
                  : undefined;
              return emitProfileOutcome && selectedProfileId
                ? {
                    ...result,
                    outcomes: [
                      {
                        provider,
                        profileId: selectedProfileId,
                        status: "ready" as const,
                      },
                    ],
                  }
                : result;
            } catch (error) {
              errors.push(error);
              throw error;
            }
          },
        },
      },
      {
        id: "healthy",
        label: "z independent provider",
        auth: [],
        catalog: {
          order: "simple",
          run: async () => ({
            provider: { baseUrl: "https://healthy.example.test", models: [] },
          }),
        },
      },
    ];
    const publish = (directory = agentDir) =>
      setRuntimeAuthProfileStoreSnapshot(published, directory);
    publish();

    return {
      store,
      published,
      profileId,
      agentDir,
      runtimeKey,
      env,
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
        resolveImplicitProviders({
          agentDir,
          authStore: store,
          config,
          env,
          onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
        }),
      emitOutcome: () => {
        emitProfileOutcome = true;
      },
      plan: (source: OpenClawConfig = {}, prepared = source) =>
        planOpenClawModelsJson({
          context: {
            cfg: source,
            discoveryAuthConfig: prepared,
            sourceConfigForSecrets: source,
            agentDir,
            env,
            envFingerprint: env,
            onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
          },
          authStore: store,
          existingRaw: "",
          existingParsed: null,
        }),
      authorization,
      authResults,
      outcomes,
      errors,

      cleanup: () => {
        clearRuntimeAuthProfileStoreSnapshots();
        setActiveDegradedSecretOwners([]);
        discovery.providers = [];
      },
    };
  }

  async function withDiscoveryFixture(
    type: "api_key" | "token",
    callback: DiscoveryCallback,
    check: (fixture: Awaited<ReturnType<typeof createDiscoveryFixture>>) => Promise<void>,
    requestedProvider = " OPENAI ",
    refSource: "store" | "env" = "store",
  ) {
    const stateDir = tempDirs.make("discovery-ref-provenance-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OPENAI_API_KEY: undefined }, async () => {
      const fixture = await createDiscoveryFixture(
        stateDir,
        type,
        callback,
        requestedProvider,
        refSource,
      );
      try {
        await check(fixture);
      } finally {
        fixture.cleanup();
      }
    });
  }

  const discoveryRefCases = [
    { type: "api_key", callback: "resolveProviderAuth", refSource: "store" },
    { type: "token", callback: "resolveProviderApiKey", refSource: "env" },
  ] as const;
  it.each(discoveryRefCases)(
    "authenticates published $refSource-backed $type discovery through $callback",
    async ({ type, callback, refSource }) => {
      await withDiscoveryFixture(
        type,
        callback,
        async (fixture) => {
          const marker = refSource === "env" ? "DISCOVERY_KEY" : NON_ENV_SECRETREF_MARKER;
          fixture.emitOutcome();
          const providers = await fixture.discover();
          expect(providers?.openai?.apiKey).toBe(marker);
          expect(fixture.outcomes).toEqual([
            { provider: "openai", profileId: fixture.profileId, status: "ready" },
          ]);
          expect(JSON.stringify(providers)).not.toContain(fixture.runtimeKey);
          expect(fixture.authorization).toEqual([`Bearer ${fixture.runtimeKey}`]);
          const plan = await fixture.plan();
          expect(plan.action).toBe("write");
          expect(JSON.stringify(plan)).toContain(marker);
          expect(JSON.stringify(plan)).not.toMatch(/runtime-discovery-key|stale-inline/);
        },
        "proof-alias",
        refSource,
      );
    },
  );

  it.each([
    ["api_key", "agent-mismatch"],
    ["api_key", "provider-mismatch"],
    ["api_key", "missing-profile"],
    ["api_key", "ref-mismatch"],
    ["token", "ref-mismatch"],
    ["api_key", "missing-value"],
    ["token", "missing-value"],
    ["api_key", "cleared"],
    ["api_key", "cold"],
    ["token", "unpublished"],
  ] as const)("isolates %s %s without fallback or anonymous HTTP", async (type, state) => {
    const refSource = state === "cold" || state === "unpublished" ? "env" : "store";
    const callback = state === "unpublished" ? "resolveProviderApiKey" : "resolveProviderAuth";
    await withDiscoveryFixture(
      type,
      callback,
      async (fixture) => {
        const { SecretSurfaceUnavailableError } =
          await import("../secrets/runtime-degraded-state.js");
        fixture.store.profiles["openai:other"] = createApiKeyCredential(
          "openai",
          "wrong-account-key",
        );
        const profile = expectDefined(
          fixture.published.profiles[fixture.profileId],
          "published profile",
        );
        if (state === "cleared") {
          await fixture.discover();
          expect(fixture.authorization).toEqual([`Bearer ${fixture.runtimeKey}`]);
          fixture.authorization.length = 0;
        }
        if (state === "unpublished" || state === "cleared") {
          fixture.clear();
        }
        if (state === "agent-mismatch") {
          fixture.clear();
          fixture.publish(path.join(fixture.agentDir, "other"));
        }
        if (state === "missing-profile") {
          delete fixture.published.profiles[fixture.profileId];
        }
        if (state === "provider-mismatch") {
          profile.provider = "other-provider";
        }
        if (state === "ref-mismatch") {
          const changedRef = { source: "store", provider: "default", id: "OTHER_KEY" } as const;
          if (profile.type === "api_key") {
            profile.keyRef = changedRef;
          } else if (profile.type === "token") {
            profile.tokenRef = changedRef;
          }
        }
        if (state === "missing-value") {
          if (profile.type === "api_key") {
            delete profile.key;
          } else if (profile.type === "token") {
            delete profile.token;
          }
        }
        if (!["unpublished", "cleared", "agent-mismatch"].includes(state)) {
          fixture.publish();
        }
        if (state === "cold") {
          fixture.cold();
        }
        // Profile-first resolution must not escape to otherwise valid ambient auth.
        if (callback === "resolveProviderAuth") {
          fixture.env.OPENAI_API_KEY = "wrong-env-key";
        }
        const providers = await fixture.discover();
        expect(fixture.authorization).toEqual([]);
        expect(fixture.errors).toHaveLength(1);
        expect(fixture.errors[0]).toBeInstanceOf(SecretSurfaceUnavailableError);
        expect(fixture.outcomes).toEqual([
          { provider: "openai", profileId: fixture.profileId, status: "unavailable" },
        ]);
        expect(providers?.openai).toBeUndefined();
        expect(providers?.healthy).toBeDefined();
        expect(JSON.stringify([providers, fixture.outcomes])).not.toMatch(
          /stale-inline|wrong-account-key|wrong-env-key|runtime-discovery-key/,
        );
      },
      "openai",
      refSource,
    );
  });

  it.each(["resolveProviderAuth"] as const)(
    "skips expired profiles through %s and uses the next canonical candidate",
    async (callback) => {
      await withDiscoveryFixture("token", callback, async (fixture) => {
        const selected = expectDefined(
          fixture.store.profiles[fixture.profileId],
          "selected profile",
        );
        if (selected.type !== "token") {
          throw new Error("expected token profile");
        }
        selected.expires = 1;
        fixture.store.profiles["openai:fallback"] = createApiKeyCredential(
          "openai",
          "eligible-fallback-key",
        );

        await fixture.discover();

        expect(fixture.authorization).toEqual(["Bearer eligible-fallback-key"]);
        expect(fixture.errors).toEqual([]);
      });
    },
  );

  it.each([undefined, "chatgpt-identity"])(
    "uses OAuth discovery credentials with auth flow %s",
    async (authFlow) => {
      await withDiscoveryFixture("api_key", "resolveProviderAuth", async (fixture) => {
        fixture.store.profiles[fixture.profileId] = {
          type: "oauth",
          provider: "openai",
          access: "oauth-key",
          refresh: "unused-refresh",
          expires: Date.now() + 600_000,
          authFlow,
        };
        await fixture.discover();
        expect(fixture.authorization).toEqual(["Bearer oauth-key"]);
        expect(fixture.authResults).toEqual([
          expect.objectContaining({
            mode: "oauth",
            discoveryApiKey: "oauth-key",
            ...(authFlow ? { authFlow } : {}),
          }),
        ]);
        expect(fixture.errors).toEqual([]);
      });
    },
  );

  it("uses cold env refs without a published auth snapshot", async () => {
    await withDiscoveryFixture("api_key", "resolveProviderAuth", async (fixture) => {
      fixture.clear();
      fixture.store.profiles[fixture.profileId] = {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "PROFILE_KEY" },
      };
      fixture.env.PROFILE_KEY = "env-ref-key";
      await fixture.discover();
      expect(fixture.authorization).toEqual(["Bearer env-ref-key"]);
      expect(fixture.errors).toEqual([]);
    });
  });

  it.each(["resolveProviderAuth", "resolveProviderApiKey"] as const)(
    "preserves profile/env precedence and ignores unselected failures through %s",
    async (callback) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        fixture.env.OPENAI_API_KEY = "ambient-key";
        fixture.store.profiles["openai:unselected"] = {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "store", provider: "default", id: "UNPUBLISHED" },
        };
        fixture.store.profiles["unrelated:oauth"] = {
          type: "oauth",
          provider: "unrelated",
          access: "expired",
          refresh: "must-not-refresh",
          expires: 1,
        };
        const resolveProfile = vi.spyOn(
          await import("./auth-profiles/oauth.js"),
          "resolveApiKeyForProfile",
        );
        try {
          await fixture.discover();
          await fixture.plan(configWithKey(configRef));
          const expectedKey =
            callback === "resolveProviderAuth" ? fixture.runtimeKey : "ambient-key";
          expect(fixture.authorization).toEqual([`Bearer ${expectedKey}`, `Bearer ${expectedKey}`]);
          expect(resolveProfile.mock.calls.map(([params]) => params.profileId)).not.toContain(
            "unrelated:oauth",
          );
          expect(fixture.errors).toEqual([]);
          expect(fixture.outcomes).toEqual([]);
        } finally {
          resolveProfile.mockRestore();
        }
      });
    },
  );

  it.each(["resolveProviderAuth"] as const)(
    "applies stored catalog order through %s",
    async (callback) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        const backupProfileId = "openai:stored-first";
        fixture.store.profiles[backupProfileId] = createApiKeyCredential(
          "openai",
          "stored-order-key",
        );
        fixture.store.order = {
          openai: [backupProfileId, fixture.profileId],
        };
        fixture.emitOutcome();

        await fixture.discover({
          auth: {
            order: {
              openai: [fixture.profileId, backupProfileId],
            },
          },
        });

        expect(fixture.authorization).toEqual(["Bearer stored-order-key"]);
        expect(fixture.outcomes).toEqual([
          { provider: "openai", profileId: backupProfileId, status: "ready" },
        ]);
      });
    },
  );

  it.each([
    ["model", "gpt-5.5", true],
    ["profile", undefined, false],
  ] as const)(
    "applies %s cooldown scope during catalog discovery",
    async (_scope, cooldownModel, keepPrimary) => {
      await withDiscoveryFixture("api_key", "resolveProviderAuth", async (fixture) => {
        const backupProfileId = "openai:cooldown-backup";
        fixture.store.profiles[backupProfileId] = createApiKeyCredential(
          "openai",
          "cooldown-backup-key",
        );
        fixture.store.usageStats = {
          [fixture.profileId]: {
            cooldownReason: "rate_limit",
            cooldownUntil: Date.now() + 60_000,
            ...(cooldownModel ? { cooldownModel } : {}),
          },
        };
        fixture.emitOutcome();
        await fixture.discover({
          auth: { order: { openai: [fixture.profileId, backupProfileId] } },
        });
        expect(fixture.authorization).toEqual([
          keepPrimary ? `Bearer ${fixture.runtimeKey}` : "Bearer cooldown-backup-key",
        ]);
        expect(fixture.outcomes).toEqual([
          {
            provider: "openai",
            profileId: keepPrimary ? fixture.profileId : backupProfileId,
            status: "ready",
          },
        ]);
      });
    },
  );

  const configRef = { source: "store", provider: "default", id: "CONFIG_KEY" } as const;
  const configWithKey = (
    apiKey: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["apiKey"],
  ): OpenClawConfig => ({
    models: {
      providers: { openai: { baseUrl: "https://catalog.example.test/v1", apiKey, models: [] } },
    },
  });
  it.each([
    { callback: "resolveProviderAuth", value: "secretref-managed" },
    { callback: "resolveProviderApiKey", value: "${OPAQUE_KEY}" },
  ] as const)(
    "keeps prepared config Ref bytes $value opaque through $callback",
    async ({ callback, value }) => {
      await withDiscoveryFixture(
        "api_key",
        callback,
        async (fixture) => {
          fixture.store.profiles = {};
          const plan = await fixture.plan(configWithKey(configRef), configWithKey(value));
          expect(fixture.authResults).toEqual([
            expect.objectContaining({ apiKey: NON_ENV_SECRETREF_MARKER, discoveryApiKey: value }),
          ]);
          expect(fixture.authorization).toEqual([`Bearer ${value}`]);
          expect(plan.action).toBe("write");
          expect(JSON.stringify(plan)).toContain(NON_ENV_SECRETREF_MARKER);
          if (value !== NON_ENV_SECRETREF_MARKER) {
            expect(JSON.stringify(plan)).not.toContain(value);
          }
          expect(JSON.stringify(plan)).not.toContain("discoveryApiKey");
        },
        "proof-alias",
      );
    },
  );

  it.each([
    { callback: "resolveProviderAuth", state: "unmaterialized" },
    { callback: "resolveProviderApiKey", state: "empty" },
  ] as const)(
    "isolates selected $state config refs through $callback before HTTP",
    async ({ callback, state }) => {
      await withDiscoveryFixture("api_key", callback, async (fixture) => {
        const { SecretSurfaceUnavailableError } =
          await import("../secrets/runtime-degraded-state.js");
        fixture.store.profiles =
          callback === "resolveProviderApiKey"
            ? { "openai:lower": { type: "api_key", provider: "openai", key: "wrong-account-key" } }
            : {};
        fixture.env.CONFIG_KEY = "wrong-env-key";
        const value = state === "empty" ? "" : configRef;
        const plan = await fixture.plan(configWithKey(configRef), configWithKey(value));
        expect(fixture.authorization).toEqual([]);
        expect(fixture.errors).toHaveLength(1);
        expect(fixture.errors[0]).toBeInstanceOf(SecretSurfaceUnavailableError);
        expect(fixture.outcomes).toEqual([{ provider: "openai", status: "unavailable" }]);
        expect(JSON.stringify(plan)).toContain("healthy");
        expect(JSON.stringify(plan)).not.toMatch(/wrong-account-key|wrong-env-key/);
      });
    },
  );

  it.each([
    { key: "xai-plugin-key", marker: NON_ENV_SECRETREF_MARKER, discoveryApiKey: "xai-plugin-key" },
    { key: "custom-local", marker: "custom-local", discoveryApiKey: undefined },
  ])("preserves synthetic auth provenance for $key", ({ key, marker, discoveryApiKey }) => {
    mockedResolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: key,
      mode: "api-key",
      source: "test plugin",
    });
    const auth = createProviderAuthResolver({}, createAuthProfileStoreFixture({}));
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
    const auth = createProviderApiKeyResolver(
      env,
      { version: 1, profiles: {} },
      configWithKey(key),
    );
    expect(auth("openai")).toEqual({
      apiKey,
      discoveryApiKey,
      ...(apiKey ? { mode: "api_key" } : {}),
    });
  });

  it.each(["api-key", "full-auth"] as const)(
    "keeps unresolved non-env refs sterile in the pure %s factory",
    (mode) => {
      const create = mode === "api-key" ? createProviderApiKeyResolver : createProviderAuthResolver;
      const auth = create({}, { version: 1, profiles: {} }, configWithKey(configRef));
      expect(auth("openai")).toEqual({
        apiKey: NON_ENV_SECRETREF_MARKER,
        discoveryApiKey: undefined,
        mode: "api_key",
        ...(mode === "full-auth" ? { source: "none" } : {}),
      });
    },
  );

  it("keeps synthetic markers in the mixed prepared credential map transport-free", async () => {
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
  const ref = (id: string) => ({ source: "env", provider: "default", id }) as const;
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
      authStore: { version: 1, profiles: {} },
      existingRaw: "",
      existingParsed: null,
    });
  }

  it("passes resolved catalog headers while persisting their source markers", async () => {
    const sourceConfig = {
      models: {
        providers: {
          "catalog-fixture": {
            baseUrl: "https://catalog.example/v1",
            api: "openai-completions",
            apiKey: ref("CATALOG_AUTH_TOKEN"),
            headers: {
              "X-Catalog-Token": ref("CATALOG_TOP_TOKEN"),
            },
            request: {
              headers: {
                "X-Request-Token": ref("CATALOG_REQUEST_TOKEN"),
              },
            },
            models: [],
          },
          "other-fixture": {
            baseUrl: "https://other.example/v1",
            headers: {
              "X-Other-Token": ref("CATALOG_OTHER_TOKEN"),
            },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          "catalog-fixture": {
            ...sourceConfig.models.providers["catalog-fixture"],
            apiKey: "activated-auth-material",
            headers: { "X-Catalog-Token": "activated-catalog-material" },
            request: { headers: { "X-Request-Token": "activated-request-material" } },
          },
          "other-fixture": {
            ...sourceConfig.models.providers["other-fixture"],
            headers: { "X-Other-Token": "other-private-material" },
          },
        },
      },
    };
    const before = structuredClone(sourceConfig);
    const observed: unknown[] = [];
    discovery.providers = [
      {
        id: "catalog-fixture",
        pluginId: "catalog-fixture",
        label: "Catalog fixture",
        auth: [],
        catalog: {
          order: "simple",
          run: async (ctx) => {
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
          },
        },
      },
    ];
    const plan = await planCatalog(sourceConfig, runtimeConfig, {
      CATALOG_TOP_TOKEN: "unactivated-env-material",
    });

    expect(observed).toEqual([
      {
        apiKey: ref("CATALOG_AUTH_TOKEN"),
        headers: { "X-Catalog-Token": "activated-catalog-material" },
        request: { headers: { "X-Request-Token": "activated-request-material" } },
        otherHeaders: {
          "X-Other-Token": ref("CATALOG_OTHER_TOKEN"),
        },
      },
    ]);
    expect(plan.action).toBe("write");
    expect(JSON.stringify(plan)).toContain("CATALOG_TOP_TOKEN");
    expect(JSON.stringify(plan)).toContain("CATALOG_REQUEST_TOKEN");
    expect(JSON.stringify(plan)).not.toContain("activated-catalog-material");
    expect(JSON.stringify(plan)).not.toContain("activated-request-material");
    expect(JSON.stringify(plan)).not.toContain("activated-auth-material");
    expect(JSON.stringify(plan)).not.toContain("other-private-material");
    expect(sourceConfig).toEqual(before);
  });

  it("keeps unresolved catalog headers fail-closed", async () => {
    const { normalizeResolvedSecretInputString } = await import("../config/types.secrets.js");
    const config = {
      models: {
        providers: {
          "catalog-fixture": {
            baseUrl: "https://catalog.example/v1",
            headers: {
              "X-Catalog-Token": ref("CATALOG_TOP_TOKEN"),
            },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    discovery.providers = [
      {
        id: "catalog-fixture",
        pluginId: "catalog-fixture",
        label: "Catalog fixture",
        auth: [],
        catalog: {
          order: "simple",
          run: async (ctx) => {
            normalizeResolvedSecretInputString({
              value:
                ctx.config.models?.providers?.["catalog-fixture"]?.headers?.["X-Catalog-Token"],
              path: "models.providers.catalog-fixture.headers.X-Catalog-Token",
            });
            throw new Error("Unresolved catalog request was admitted");
          },
        },
      },
    ];

    await expect(planCatalog(config, structuredClone(config))).rejects.toThrow(
      "unresolved SecretRef",
    );
  });
});
