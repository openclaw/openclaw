import { afterEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretRef } from "../config/types.secrets.js";
import type { ProviderModelRouteCandidate } from "../plugin-sdk/provider-model-types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  createApiKeyCredential,
  createUnresolvedOAuthCredential,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { buildAgentHarnessSupportContext } from "./harness/support.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  dualRoutes,
  evaluate,
  platformRoute,
  routeResolverFactory,
  mockRouteResolverFactory,
  subscriptionRoute,
} from "./model-auth-availability.test-support.js";
import { configForProviders, providerConfig } from "./model-auth.fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

function resolverWith(
  options: Partial<Parameters<typeof createModelAuthAvailabilityResolver>[0]> = {},
) {
  return createModelAuthAvailabilityResolver({
    cfg: {},
    authStore: authStore(),
    env: {},
    ...options,
  });
}

const keyProfile = (key = "platform-key", provider = "openai") =>
  createApiKeyCredential(provider, key);
const profileStore = (id: string, profile: AuthProfileCredential) => authStore({ [id]: profile });
const envProfile = (id = "OPENAI_API_KEY"): AuthProfileCredential => ({
  type: "api_key",
  provider: "openai",
  keyRef: { source: "env", provider: "default", id },
});
const openAiOAuthProfile = (overrides: Parameters<typeof createOAuthRefreshCredential>[0] = {}) =>
  createOAuthRefreshCredential({ access: "oauth-access", refresh: "oauth-refresh", ...overrides });
const metadataWithAlias = (id: string, alias: string, origin: "global" | "bundled") =>
  createPluginMetadataSnapshotFixture({
    plugins: [{ id, origin, providerAuthAliases: { [alias]: id } }],
  });

function expectAuth(params: Parameters<typeof evaluate>[0]) {
  return expect(evaluate(params));
}
type AuthCase = [string, Parameters<typeof evaluate>[0], Partial<ReturnType<typeof evaluate>>];
function selection(
  availability: boolean | undefined,
  evidence: NonNullable<ReturnType<typeof evaluate>["evidence"]>,
  selectedRoute: ProviderModelRouteCandidate = platformRoute,
  extra: Partial<ReturnType<typeof evaluate>> = {},
) {
  return { availability, evidence, selectedRoute, ...extra };
}

const keyRef = { source: "file", provider: "vault", id: "value" } as const;
const referencedProfile = (key?: string): AuthProfileCredential => ({
  type: "api_key",
  provider: "openai",
  keyRef,
  ...(key ? { key } : {}),
});

function materialization(
  modelId: string,
  authMode: "oauth" | "api-key" = "oauth",
  authProfileId?: string,
) {
  return {
    provider: "openai",
    modelId,
    modelApi: authMode === "oauth" ? "openai-chatgpt-responses" : "openai-responses",
    modelBaseUrl:
      authMode === "oauth" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
    requestTransportOverrides: "none" as const,
    authMode,
    runtimeOwnerId: "codex",
    ...(authProfileId ? { authProfileId } : {}),
  };
}

describe("createModelAuthAvailabilityResolver", () => {
  it("projects provider-selected sharing consent into public Responses harness support", () => {
    const cfg = { auth: { order: { openai: ["openai:shared"] } } };
    const auth = resolverWith({
      cfg,
      authStore: profileStore(
        "openai:shared",
        openAiOAuthProfile({ authFlow: "chatgpt-token-sharing" }),
      ),
    }).evaluateRuntimeModelAuth("openai", {
      modelId: "gpt-5.4",
      runtimeId: "codex",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(auth).toMatchObject({
      availability: true,
      selectedCredential: {
        source: "profile",
        mode: "oauth",
        authFlow: "chatgpt-token-sharing",
        requirement: "api-key",
      },
    });
    expect(
      buildAgentHarnessSupportContext({
        config: cfg,
        provider: "openai",
        modelId: "gpt-5.4",
        requestedRuntime: "codex",
        modelProvider: { ...auth.selectedRoute, preparedAuth: auth.selectedCredential },
      }).modelProvider,
    ).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: expect.arrayContaining(["openclaw", "codex"]) },
      preparedAuth: {
        source: "profile",
        mode: "oauth",
        authFlow: "chatgpt-token-sharing",
        requirement: "api-key",
      },
    });
  });

  it.each<AuthCase>([
    [
      "uses prepared API-key auth with no profiles",
      { preparedRuntimeAuthModes: { openai: "api_key" } },
      selection(true, "runtime", platformRoute, { selectedAuthMode: "api_key" }),
    ],
    [
      "uses prepared OAuth with no profiles",
      { preparedRuntimeAuthModes: { openai: "oauth" } },
      selection(true, "runtime", subscriptionRoute, { selectedAuthMode: "oauth" }),
    ],
    [
      "uses configured OAuth after an unavailable API profile",
      {
        cfg: configForProviders({
          openai: { auth: "oauth", apiKey: "configured-oauth-token", models: [] },
        }),
        store: profileStore("openai:platform-missing", keyProfile("")),
      },
      selection(true, "provider-config", subscriptionRoute, { selectedAuthMode: "oauth" }),
    ],
    [
      "honors an automatic profile preference ahead of stored order",
      {
        store: authStore(
          { "openai:platform": keyProfile(), "openai:chatgpt": openAiOAuthProfile() },
          { openai: ["openai:platform", "openai:chatgpt"] },
        ),
        ref: { preferredProfileId: "openai:chatgpt" },
      },
      { selectedProfileId: "openai:chatgpt", selectedRoute: subscriptionRoute },
    ],
    [
      "prefers ambient environment auth to non-explicit provider material",
      {
        cfg: providerConfig("openai", { apiKey: "configured-platform-key" }),
        env: { OPENAI_API_KEY: "environment-key" },
      },
      selection(true, "environment", platformRoute, { selectedAuthMode: "api-key" }),
    ],
    [
      "resolves an environment SecretRef profile",
      {
        env: { OPENAI_API_KEY: "resolved-key" },
        store: profileStore("openai:ref", envProfile()),
      },
      selection(true, "profile", platformRoute, { selectedProfileId: "openai:ref" }),
    ],
    [
      "keeps an unread environment SecretRef profile indeterminate",
      {
        env: {},
        store: profileStore("openai:ref", envProfile()),
      },
      selection(undefined, "profile", platformRoute, { selectedProfileId: "openai:ref" }),
    ],
    [
      "keeps ref-only OAuth indeterminate until runtime hydration",
      {
        store: profileStore("openai:legacy-ref", createUnresolvedOAuthCredential()),
      },
      selection(undefined, "profile", subscriptionRoute, {
        selectedAuthMode: "oauth",
        selectedProfileId: "openai:legacy-ref",
      }),
    ],
  ])("%s", (_name, params, expected) => expectAuth(params).toMatchObject(expected));

  it("canonicalizes prepared runtime auth through provider aliases", () => {
    const metadataSnapshot = metadataWithAlias("external-cloud", "cloud-alias", "global");
    const resolver = resolverWith({
      metadataSnapshot,
      preparedRuntimeAuthModes: { "external-cloud": "api_key" },
    });

    expect(resolver.evaluateModelAuth("cloud-alias")).toMatchObject({
      availability: true,
      evidence: "runtime",
      routeResolution: null,
      selectedAuthMode: "api_key",
    });
    const syntheticResolver = resolverWith({
      metadataSnapshot,
      syntheticAuthProviderRefs: ["cloud-alias"],
    });
    expect(syntheticResolver.evaluateModelAuth("cloud-alias")).toEqual({
      availability: undefined,
      evidence: "synthetic",
      routeResolution: null,
    });
    expect(syntheticResolver.evaluateModelAuth("external-cloud").unavailableReason).toBe(
      "missing-auth",
    );
  });

  it("keeps prepared native-runtime authentication scoped to its exact owner", () => {
    const resolver = resolverWith({
      metadataSnapshot: metadataWithAlias("anthropic", "claude-cli", "bundled"),
      preparedRuntimeAuthModes: { "claude-cli": "api_key" },
    });

    expect(resolver.evaluateModelAuth("claude-cli")).toMatchObject({
      availability: true,
      evidence: "runtime",
      selectedAuthMode: "api_key",
    });
    expect(resolver.evaluateModelAuth("anthropic").availability).not.toBe(true);
  });

  it("keeps configured local providers independent from native-auth probe completion", () => {
    const resolver = resolverWith({
      cfg: providerConfig("local-openai", {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
      }),
      preparedSyntheticAuthComplete: true,
    });

    const evaluation = resolver.evaluateModelAuth("local-openai");
    expect(evaluation).toMatchObject({ availability: undefined });
  });

  it.each([
    ["gpt-5.4", "gpt-5.5"],
    ["Model", "model"],
    ["model", "Model"],
  ])(
    "keeps successful harness auth scoped to the exact model route %s",
    (modelId, otherModelId) => {
      const preparedRuntimeAuthMaterializations = [materialization(modelId)];
      const store = profileStore("openai:default", envProfile());

      expectAuth({
        store,
        ref: { modelId },
        preparedRuntimeAuthMaterializations,
      }).toMatchObject({
        availability: true,
        evidence: "runtime",
        selectedRoute: subscriptionRoute,
      });
      expect(
        evaluate({
          store,
          ref: { modelId: otherModelId },
          preparedRuntimeAuthMaterializations,
        }).availability,
      ).not.toBe(true);
      expectAuth({
        cfg: providerConfig("openai", {
          auth: "api-key",
          apiKey: "configured-platform-key",
          baseUrl: "https://api.openai.com/v1",
        }),
        store,
        ref: { modelId },
        preparedRuntimeAuthMaterializations,
      }).toMatchObject({
        availability: true,
        evidence: "provider-config",
        selectedRoute: platformRoute,
      });
    },
  );

  it.each([
    { label: "matching", authProfileId: "openai:default", availability: true },
    { label: "omitted", authProfileId: "openai:other", availability: false },
    { label: "unscoped", authProfileId: undefined, availability: false },
  ])(
    "uses $label successful harness auth only when explicit order admits its profile",
    ({ authProfileId, availability }) => {
      const store = authStore({
        "openai:default": referencedProfile(),
        "openai:other": referencedProfile(),
      });

      expectAuth({
        cfg: { auth: { order: { openai: ["openai:default"] } } },
        store,
        ref: { modelId: "gpt-5.4" },
        preparedRuntimeAuthMaterializations: [materialization("gpt-5.4", "api-key", authProfileId)],
      }).toMatchObject({
        availability,
        selectedProfileId: "openai:default",
        selectedRoute: platformRoute,
      });
    },
  );

  it.each([
    { label: "resolved", key: "runtime-key", availability: true },
    { label: "unresolved", key: undefined, availability: undefined },
  ])("uses an exact $label prepared SecretRef profile", ({ key, availability }) => {
    expectAuth({
      cfg: {
        secrets: {
          providers: {
            vault: { source: "file", path: "/tmp/test-secret", mode: "singleValue" },
          },
        },
      },
      store: profileStore("openai:default", referencedProfile()),
      preparedRuntimeAuthStore: profileStore("openai:default", referencedProfile(key)),
    }).toMatchObject(
      selection(availability, "profile", platformRoute, { selectedProfileId: "openai:default" }),
    );
  });

  it.each([
    [
      "incompatible",
      {
        kind: "incompatible" as const,
        code: "platform-only-model-on-chatgpt",
        message: "Platform-only model",
      },
      false,
    ],
    ["indeterminate", { kind: "indeterminate" as const, defaultRuntimeId: "codex" }, undefined],
  ] as const)("preserves an %s provider route decision", (_label, resolution, availability) => {
    expect(evaluate({ resolution })).toEqual({ availability, routeResolution: resolution });
  });

  it("projects route-independent auth-order failures for indeterminate routes", () => {
    const resolution = { kind: "indeterminate" as const, defaultRuntimeId: "codex" };
    const cooldownStore = profileStore("openai:cooldown", keyProfile());
    cooldownStore.usageStats = {
      "openai:cooldown": { cooldownUntil: Date.now() + 60_000 },
    };

    expectAuth({ resolution, store: cooldownStore }).toMatchObject({
      availability: false,
      evidence: "profile",
      selectedProfileId: "openai:cooldown",
    });
    expectAuth({
      cfg: { auth: { order: { openai: [] } } },
      resolution,
    }).toMatchObject({ availability: false, evidence: "profile" });
  });

  it.each([
    ["custom API-key endpoint", "https://openai-compatible.example/v1", undefined],
    ["configured API-key auth", platformRoute.baseUrl, "auth-failed"],
  ] as const)("does not pair ChatGPT OAuth with %s", (_label, baseUrl, unavailableReason) => {
    const route = { ...platformRoute, baseUrl } satisfies ProviderModelRouteCandidate;
    const result = evaluate({
      cfg:
        baseUrl === platformRoute.baseUrl
          ? providerConfig("openai", { auth: "api-key" })
          : undefined,
      resolution:
        baseUrl === platformRoute.baseUrl
          ? dualRoutes
          : { kind: "routes", defaultRuntimeId: "openclaw", routes: [route] },
      store: profileStore("openai:chatgpt", openAiOAuthProfile()),
    });
    expect(result).toMatchObject({
      availability: false,
      selectedRoute: route,
      ...(unavailableReason ? { unavailableReason } : {}),
    });
    expect(result.selectedProfileId).toBeUndefined();
  });

  it.each([
    {
      label: "Platform environment after unavailable OAuth",
      env: { OPENAI_API_KEY: "environment-key" },
      profileId: "openai:oauth-missing",
      profile: openAiOAuthProfile({ access: "", refresh: "" }),
    },
    {
      label: "OAuth environment after unavailable Platform auth",
      cfg: providerConfig("openai", { auth: "oauth" }),
      env: { OPENAI_API_KEY: "environment-token" },
      profileId: "openai:platform-missing",
      profile: keyProfile(""),
    },
  ])(
    "reports $label unavailable rather than substituting an ambient credential",
    ({ cfg, env, profile, profileId }) => {
      expectAuth({ cfg, env, store: authStore({ [profileId]: profile }) }).toMatchObject({
        availability: false,
      });
    },
  );

  it("does not grant refresh authority to an unsupported external CLI id", () => {
    mockRouteResolverFactory(routeResolverFactory(null));
    const resolver = resolverWith({
      authStore: profileStore(
        "acme:cli",
        openAiOAuthProfile({
          provider: "acme-cli",
          access: "expired-access",
          refresh: "stored-refresh",
          expires: Date.now() - 60_000,
        }),
      ),
      externalCliProviderIds: ["acme-cli"],
    });

    expect(resolver.resolveProviderAuthAvailability("acme-cli")).toBeUndefined();
  });

  it.each<[string, AuthProfileCredential, Partial<ReturnType<typeof evaluate>>]>([
    [
      "stops at an unresolved",
      envProfile("MISSING_OPENAI_KEY"),
      selection(undefined, "profile", platformRoute, { selectedProfileId: "openai:first" }),
    ],
    [
      "skips a definitively invalid",
      keyProfile(""),
      { availability: true, selectedProfileId: "openai:chatgpt", selectedRoute: subscriptionRoute },
    ],
  ])("%s ordered profile before a usable sibling", (_label, profile, expected) => {
    expectAuth({
      cfg: { auth: { order: { openai: ["openai:first", "openai:chatgpt"] } } },
      store: authStore({
        "openai:first": profile,
        "openai:chatgpt": openAiOAuthProfile(),
      }),
    }).toMatchObject(expected);
  });

  const openClawOnlyRoute = {
    ...platformRoute,
    runtimePolicy: { compatibleIds: ["openclaw"] },
  } satisfies ProviderModelRouteCandidate;
  it.each<AuthCase>([
    [
      "defers one unconfigured route to native validation",
      { resolution: { ...dualRoutes, routes: [subscriptionRoute] } },
      { availability: undefined, evidence: "synthetic" },
    ],
    [
      "ignores invalid automatic profile evidence",
      { store: profileStore("openai:invalid", keyProfile("")) },
      { availability: undefined, evidence: "synthetic", routeResolution: dualRoutes },
    ],
    [
      "cannot own an OpenClaw-only route",
      { resolution: { ...dualRoutes, defaultRuntimeId: "openclaw", routes: [openClawOnlyRoute] } },
      { availability: false, selectedRoute: openClawOnlyRoute },
    ],
  ])("synthetic Codex auth %s", (_label, params, expected) => {
    expectAuth({
      ...params,
      syntheticAuthProviderRefs: ["codex"],
    }).toMatchObject(expected);
  });

  it.each([
    {
      label: "explicit",
      cfg: providerConfig("amazon-bedrock", {
        api: "bedrock-converse-stream",
        auth: "aws-sdk",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      }),
    },
    { label: "implicit", cfg: {} },
  ])("keeps an $label Bedrock AWS SDK route ready", ({ cfg }) => {
    const result = resolverWith({ cfg }).evaluateModelAuth("amazon-bedrock", {
      api: "bedrock-converse-stream",
    });

    expect(result).toMatchObject({
      availability: true,
      evidence: "aws-sdk",
      routeResolution: null,
      selectedAuthMode: "aws-sdk",
    });
  });

  it.each<{
    name: string;
    apiKey: SecretRef;
    secrets: OpenClawConfig["secrets"];
  }>([
    {
      name: "env",
      apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
      secrets: { providers: { default: { source: "env" } } },
    },
    {
      name: "store default shadowing file",
      apiKey: { source: "store", provider: "shared", id: "ANTHROPIC_API_KEY" },
      secrets: {
        defaults: { store: "shared" },
        providers: { shared: { source: "file", path: "/tmp/unused-store-alias-fixture.json" } },
      },
    },
  ])(
    "keeps a non-OpenAI provider $name SecretRef unresolved without reading it",
    ({ apiKey, secrets }) => {
      const result = resolverWith({
        cfg: {
          ...providerConfig("anthropic", {
            api: "anthropic-messages",
            apiKey,
            baseUrl: "https://api.anthropic.com",
          }),
          secrets,
        },
      }).evaluateModelAuth("anthropic", {
        modelId: "claude-sonnet-4-6",
        api: "anthropic-messages",
      });

      expect(result).toMatchObject({
        availability: undefined,
        evidence: "provider-config",
        routeResolution: null,
        selectedAuthMode: "api-key",
      });
      expect(result.unavailableReason).toBeUndefined();
    },
  );
});

describe("credential readiness and retry reasons", () => {
  const catalogRef = { source: "store", provider: "default", id: "CATALOG_KEY" } as const;
  afterEach(clearRuntimeConfigSnapshot);

  function readiness(cfg: OpenClawConfig, store = authStore()) {
    return resolverWith({ cfg, authStore: store });
  }

  it.each([
    { name: "resolved profile collision", key: "bound", available: true },
    { name: "literal profile binding", key: "bound", literal: true, available: false },
    { name: "literal local marker", key: "ollama-local", literal: true, available: undefined },
    { name: "literal env marker", key: "OPENAI_API_KEY", literal: true, available: false },
    { name: "literal malformed syntax", key: "$not-a-template", literal: true, available: false },
    { name: "unresolved snapshot", snapshot: "unresolved", available: undefined },
    { name: "empty profile order", key: "ollama-local", order: true, available: true },
    { name: "explicit lock", key: "ollama-local", locked: true, available: false },
  ])(
    "preserves source ownership for $name",
    ({ key, literal, snapshot, order, locked, available }) => {
      const sourceConfig = {
        ...providerConfig("acme", {
          baseUrl: "https://acme.example/v1",
          apiKey: literal ? key : catalogRef,
        }),
        ...(order ? { auth: { order: { acme: [] } } } : {}),
      };
      const runtimeConfig = structuredClone(sourceConfig);
      if (snapshot !== "unresolved") {
        runtimeConfig.models.providers.acme!.apiKey = key;
      }
      const store = authStore({
        bound: { type: "api_key", provider: "other", key: "profile-key" },
      });
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      const cfg = runtimeConfig;
      const result = readiness(cfg, store).evaluateModelAuth(
        "acme",
        locked ? { pinnedProfileId: "bound" } : {},
      );
      expect(result.availability).toBe(available);
      if (available === true) {
        expect(result.evidence).toBe("runtime");
        expect(result.selectedProfileId).toBeUndefined();
        const prepared = prepareAgentRuntimeAuth({
          provider: "acme",
          modelId: "discovered",
          config: cfg,
          authProfileStore: store,
          env: {},
        });
        expect(prepared.attempts[0]).toMatchObject({
          kind: "direct",
          allowAuthProfileFallback: false,
          plan: { credentialSource: { kind: "direct", authorization: "declared" } },
        });
      }
    },
  );
  it.each(["openai", "anthropic"])(
    "distinguishes missing, failed, unknown, and ready credentials for %s",
    (provider) => {
      const ref = (source: "file" | "env", owner: string, id: string): AuthProfileCredential => ({
        type: "api_key",
        provider,
        keyRef: { source, provider: owner, id },
      });
      const cases: [string, AuthProfileCredential | undefined, string | undefined][] = [
        ["no evidence", undefined, "missing-auth"],
        ["expired", { type: "token", provider, token: "expired-token", expires: 1 }, "auth-failed"],
        ["invalid reference", ref("file", "absent", "key"), "auth-failed"],
        ["unread reference", ref("env", "default", "UNREAD_KEY"), undefined],
        ["ready", createApiKeyCredential(provider, "test-key"), undefined],
      ];
      for (const [label, profile, reason] of cases) {
        mockRouteResolverFactory(routeResolverFactory(dualRoutes));
        const result = resolverWith({
          authStore: authStore(profile ? { test: profile } : {}),
        }).evaluateModelAuth(provider);
        expect.soft(result.unavailableReason, label).toBe(reason);
        expect.soft(result.unavailableUntil, label).toBeUndefined();
      }
    },
  );

  it("reports the earliest retry among viable cooling profiles, excluding invalid or permanently rejected profiles", () => {
    const until = Date.now() + 60_000;
    const store = authStore({
      first: createApiKeyCredential("openai", "first-key"),
      second: createApiKeyCredential("openai", "second-key"),
      invalid: { type: "token", provider: "openai", token: "expired-token", expires: 1 },
      rejected: createApiKeyCredential("openai", "rejected-key"),
    });
    store.usageStats = {
      first: { cooldownUntil: until + 60_000 },
      second: { cooldownUntil: until },
      invalid: { cooldownUntil: until - 30_000 },
      rejected: { disabledUntil: until - 45_000, disabledReason: "auth_permanent" },
    };
    expectAuth({ store, ref: { preferredProfileId: "first" } }).toMatchObject({
      availability: false,
      unavailableReason: "cooldown",
      unavailableUntil: until,
    });
    expectAuth({ store, ref: { pinnedProfileId: "invalid" } }).toMatchObject({
      availability: false,
      unavailableReason: "auth-failed",
    });
  });

  it.each(["profile", "inline", "hydrated-inline"] as const)(
    "distinguishes %s permanent auth rejection from active retry windows",
    (source) => {
      const until = Date.now() + 60_000;
      const cases = [
        [{ cooldownUntil: until }, "cooldown", until],
        [{ disabledUntil: until, disabledReason: "auth_permanent" }, "auth-failed", undefined],
        [
          { disabledUntil: 1, disabledReason: "auth_permanent", cooldownUntil: until },
          "cooldown",
          until,
        ],
        [{ disabledUntil: until, disabledReason: "billing" }, "cooldown", until],
      ] as const;
      for (const [stats, reason, retryAt] of cases) {
        clearRuntimeConfigSnapshot();
        const store = authStore({
          bound: createApiKeyCredential("anthropic", "test-key"),
        });
        store.usageStats = {
          [source === "profile" ? "bound" : "inline-api-key:anthropic"]: stats,
        };
        const cfg = providerConfig("anthropic", {
          auth: "api-key",
          apiKey: source === "profile" ? "bound" : "inline-key",
          baseUrl: "https://api.anthropic.com",
        });
        if (source === "hydrated-inline") {
          const sourceConfig = providerConfig("anthropic", {
            ...cfg.models.providers.anthropic,
            apiKey: catalogRef,
          });
          cfg.models.providers.anthropic!.apiKey = "ollama-local";
          setRuntimeConfigSnapshot(cfg, sourceConfig);
        }
        const result = readiness(cfg, store).evaluateModelAuth("anthropic");
        expect.soft(result, JSON.stringify(stats)).toMatchObject({
          availability: false,
          unavailableReason: reason,
        });
        expect.soft(result.unavailableUntil, JSON.stringify(stats)).toBe(retryAt);
      }
    },
  );
});
