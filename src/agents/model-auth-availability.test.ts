import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../config/resolution-facts.js";
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
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
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
import { providerConfig } from "./model-auth.fixtures.test-support.js";
import type { createOpenAIModelRoutesResolver } from "./openai-model-routes.js";
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

function openAiOAuthProfile() {
  return createOAuthRefreshCredential({ access: "oauth-access", refresh: "oauth-refresh" });
}

describe("createModelAuthAvailabilityResolver", () => {
  it("canonicalizes prepared runtime auth through provider aliases", () => {
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "external-cloud",
          origin: "global",
          providerAuthAliases: { "cloud-alias": "external-cloud" },
        },
      ],
    });
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
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "anthropic",
          origin: "bundled",
          providerAuthAliases: { "claude-cli": "anthropic" },
        },
      ],
    });
    const resolver = resolverWith({
      metadataSnapshot,
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
    { mode: "api_key" as const, selectedRoute: platformRoute },
    { mode: "oauth" as const, selectedRoute: subscriptionRoute },
  ])(
    "uses prepared runtime $mode auth when the profile snapshot is empty",
    ({ mode, selectedRoute }) => {
      expect(evaluate({ preparedRuntimeAuthModes: { openai: mode } })).toMatchObject({
        availability: true,
        evidence: "runtime",
        selectedAuthMode: mode,
        selectedRoute,
      });
    },
  );

  it.each([
    ["gpt-5.4", "gpt-5.5"],
    ["Model", "model"],
    ["model", "Model"],
  ])(
    "keeps successful harness auth scoped to the exact model route %s",
    (modelId, otherModelId) => {
      const materialization = {
        provider: "openai",
        modelId,
        modelApi: "openai-chatgpt-responses",
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        requestTransportOverrides: "none",
        authMode: "oauth",
        runtimeOwnerId: "codex",
      } as const;
      const store = authStore({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
        },
      });

      expect(
        evaluate({
          store,
          ref: { modelId },
          preparedRuntimeAuthMaterializations: [materialization],
        }),
      ).toMatchObject({
        availability: true,
        evidence: "runtime",
        selectedRoute: subscriptionRoute,
      });
      expect(
        evaluate({
          store,
          ref: { modelId: otherModelId },
          preparedRuntimeAuthMaterializations: [materialization],
        }).availability,
      ).not.toBe(true);
      expect(
        evaluate({
          cfg: providerConfig("openai", {
            auth: "api-key",
            apiKey: "configured-platform-key",
            baseUrl: "https://api.openai.com/v1",
          }),
          store,
          ref: { modelId },
          preparedRuntimeAuthMaterializations: [materialization],
        }),
      ).toMatchObject({
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
      const keyRef = { source: "file" as const, provider: "vault", id: "value" };
      const store = authStore({
        "openai:default": { type: "api_key", provider: "openai", keyRef },
        "openai:other": { type: "api_key", provider: "openai", keyRef },
      });
      const materialization = {
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        modelBaseUrl: "https://api.openai.com/v1",
        requestTransportOverrides: "none",
        authMode: "api-key",
        runtimeOwnerId: "codex",
        ...(authProfileId ? { authProfileId } : {}),
      } as const;

      expect(
        evaluate({
          cfg: { auth: { order: { openai: ["openai:default"] } } },
          store,
          ref: { modelId: "gpt-5.4" },
          preparedRuntimeAuthMaterializations: [materialization],
        }),
      ).toMatchObject({
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
    const keyRef = { source: "file" as const, provider: "vault", id: "value" };
    const persisted = authStore({
      "openai:default": { type: "api_key", provider: "openai", keyRef },
    });
    const preparedRuntimeAuthStore = authStore({
      "openai:default": {
        type: "api_key",
        provider: "openai",
        keyRef,
        ...(key ? { key } : {}),
      },
    });

    expect(
      evaluate({
        cfg: {
          secrets: {
            providers: {
              vault: { source: "file", path: "/tmp/test-secret", mode: "singleValue" },
            },
          },
        },
        store: persisted,
        preparedRuntimeAuthStore,
      }),
    ).toMatchObject({
      availability,
      evidence: "profile",
      selectedProfileId: "openai:default",
      selectedRoute: platformRoute,
    });
  });

  it.each([
    {
      label: "incompatible",
      resolution: {
        kind: "incompatible" as const,
        code: "platform-only-model-on-chatgpt",
        message: "Platform-only model",
      },
      availability: false,
    },
    {
      label: "indeterminate",
      resolution: { kind: "indeterminate" as const, defaultRuntimeId: "codex" },
      availability: undefined,
    },
  ])("preserves an $label provider route decision", ({ availability, resolution }) => {
    expect(evaluate({ resolution })).toEqual({ availability, routeResolution: resolution });
  });

  it("projects route-independent auth-order failures for indeterminate routes", () => {
    const resolution = { kind: "indeterminate" as const, defaultRuntimeId: "codex" };
    const cooldownStore = authStore({
      "openai:cooldown": createApiKeyCredential("openai", "platform-key"),
    });
    cooldownStore.usageStats = {
      "openai:cooldown": { cooldownUntil: Date.now() + 60_000 },
    };

    expect(evaluate({ resolution, store: cooldownStore })).toMatchObject({
      availability: false,
      evidence: "profile",
      selectedProfileId: "openai:cooldown",
    });
    expect(
      evaluate({
        cfg: { auth: { order: { openai: [] } } },
        resolution,
      }),
    ).toMatchObject({ availability: false, evidence: "profile" });
  });

  it("does not let ChatGPT OAuth satisfy a custom API-key endpoint", () => {
    const customRoute = {
      ...platformRoute,
      baseUrl: "https://openai-compatible.example/v1",
    } satisfies ProviderModelRouteCandidate;
    const result = evaluate({
      resolution: { kind: "routes", defaultRuntimeId: "openclaw", routes: [customRoute] },
      store: authStore({
        "openai:chatgpt": openAiOAuthProfile(),
      }),
    });

    expect(result).toMatchObject({ availability: false, selectedRoute: customRoute });
    expect(result.selectedProfileId).toBeUndefined();
  });

  it.each([
    {
      auth: "oauth" as const,
      profile: { type: "api_key" as const, provider: "openai", key: "platform-key" },
      route: subscriptionRoute,
    },
    {
      auth: "api-key" as const,
      profile: openAiOAuthProfile(),
      route: platformRoute,
    },
  ])(
    "does not pair a $profile.type profile with configured $auth auth",
    ({ auth, profile, route }) => {
      const result = evaluate({
        cfg: providerConfig("openai", { auth }),
        store: authStore({ "openai:wrong-route": profile }),
      });

      expect(result).toMatchObject({
        availability: false,
        unavailableReason: "auth-failed",
        selectedRoute: route,
      });
      expect(result.selectedProfileId).toBeUndefined();
    },
  );

  it.each([
    { provider: "anthropic", mode: "api_key" as const },
    { provider: "openai", mode: "oauth" as const },
  ])("rejects a bound profile with conflicting $provider/$mode metadata", ({ mode, provider }) => {
    expect(
      evaluate({
        cfg: {
          auth: {
            profiles: {
              "openai:bound": { provider, mode },
            },
          },
          ...providerConfig("openai", { apiKey: "openai:bound" }),
        } as OpenClawConfig,
        store: authStore({
          "openai:bound": createApiKeyCredential("openai", "bound-platform-key"),
        }),
      }),
    ).toMatchObject({
      availability: false,
      evidence: "profile",
      selectedAuthMode: "api_key",
      selectedProfileId: "openai:bound",
      selectedRoute: platformRoute,
    });
  });

  it("uses configured OAuth direct material after an unavailable API profile", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            auth: "oauth",
            apiKey: "configured-oauth-token",
            models: [],
          },
        },
      },
    };

    expect(
      evaluate({
        cfg,
        store: authStore({
          "openai:platform-missing": {
            type: "api_key",
            provider: "openai",
            key: "",
          },
        }),
      }),
    ).toMatchObject({
      availability: true,
      evidence: "provider-config",
      selectedAuthMode: "oauth",
      selectedRoute: subscriptionRoute,
    });
  });

  it("honors an automatic profile preference ahead of stored order", () => {
    const store = authStore(
      {
        "openai:platform": createApiKeyCredential("openai", "platform-key"),
        "openai:chatgpt": openAiOAuthProfile(),
      },
      { openai: ["openai:platform", "openai:chatgpt"] },
    );

    expect(evaluate({ store, ref: { preferredProfileId: "openai:chatgpt" } })).toMatchObject({
      selectedProfileId: "openai:chatgpt",
      selectedRoute: subscriptionRoute,
    });
  });

  it("keeps ambient environment auth ahead of non-explicit provider material", () => {
    expect(
      evaluate({
        cfg: providerConfig("openai", { apiKey: "configured-platform-key" }),
        env: { OPENAI_API_KEY: "environment-key" },
      }),
    ).toMatchObject({
      availability: true,
      evidence: "environment",
      selectedAuthMode: "api-key",
      selectedRoute: platformRoute,
    });
  });

  it.each([
    {
      label: "Platform environment after unavailable OAuth",
      env: { OPENAI_API_KEY: "environment-key" },
      profileId: "openai:oauth-missing",
      profile: { type: "oauth" as const, provider: "openai", access: "", refresh: "" },
    },
    {
      label: "OAuth environment after unavailable Platform auth",
      cfg: providerConfig("openai", { auth: "oauth" }),
      env: { OPENAI_API_KEY: "environment-token" },
      profileId: "openai:platform-missing",
      profile: { type: "api_key" as const, provider: "openai", key: "" },
    },
    // An environment credential named nowhere in config is not authorized to
    // stand in for a declared profile, including a declared profile that turned
    // out to be unusable. Availability mirrors the runtime rule here so status
    // does not advertise a credential the run would refuse to use.
  ])(
    "reports $label unavailable rather than substituting an ambient credential",
    ({ cfg, env, profile, profileId }) => {
      expect(evaluate({ cfg, env, store: authStore({ [profileId]: profile }) })).toMatchObject({
        availability: false,
      });
    },
  );

  it.each([
    { env: { OPENAI_API_KEY: "resolved-key" }, availability: true },
    { env: {}, availability: undefined },
  ])("reports a SecretRef profile as $availability", ({ availability, env }) => {
    expect(
      evaluate({
        env,
        store: authStore({
          "openai:ref": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        }),
      }),
    ).toMatchObject({
      availability,
      evidence: "profile",
      selectedProfileId: "openai:ref",
      selectedRoute: platformRoute,
    });
  });

  it("keeps a ref-only OAuth profile indeterminate until runtime hydration", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:legacy-ref": {
            type: "oauth",
            provider: "openai",
            access: "",
            refresh: "",
            expires: 0,
            oauthRef: {
              source: "openclaw-credentials",
              provider: "openai-codex",
              id: "00000000000000000000000000000000",
            },
          },
        }),
      }),
    ).toMatchObject({
      availability: undefined,
      evidence: "profile",
      selectedAuthMode: "oauth",
      selectedProfileId: "openai:legacy-ref",
      selectedRoute: subscriptionRoute,
    });
  });

  it("does not grant refresh authority to an unsupported external CLI id", () => {
    mockRouteResolverFactory(routeResolverFactory(null));
    const resolver = resolverWith({
      cfg: {} as OpenClawConfig,
      authStore: authStore({
        "acme:cli": {
          type: "oauth",
          provider: "acme-cli",
          access: "expired-access",
          refresh: "stored-refresh",
          expires: Date.now() - 60_000,
        },
      }),
      externalCliProviderIds: ["acme-cli"],
    });

    expect(resolver.resolveProviderAuthAvailability("acme-cli")).toBeUndefined();
  });

  it("does not borrow usable auth from a later sibling route after an unresolved ordered profile", () => {
    const result = evaluate({
      cfg: { auth: { order: { openai: ["openai:unknown", "openai:chatgpt"] } } },
      store: authStore({
        "openai:unknown": {
          type: "api_key",
          provider: "openai",
          keyRef: { source: "env", provider: "default", id: "MISSING_OPENAI_KEY" },
        },
        "openai:chatgpt": openAiOAuthProfile(),
      }),
    });

    expect(result).toMatchObject({
      availability: undefined,
      evidence: "profile",
      selectedProfileId: "openai:unknown",
      selectedRoute: platformRoute,
    });
  });

  it("skips a definitively invalid profile before selecting a usable sibling route", () => {
    expect(
      evaluate({
        cfg: { auth: { order: { openai: ["openai:invalid", "openai:chatgpt"] } } },
        store: authStore({
          "openai:invalid": { type: "api_key", provider: "openai", key: "" },
          "openai:chatgpt": openAiOAuthProfile(),
        }),
      }),
    ).toMatchObject({
      availability: true,
      selectedProfileId: "openai:chatgpt",
      selectedRoute: subscriptionRoute,
    });
  });

  it("keeps one unconfigured Codex route indeterminate until native account validation", () => {
    expect(
      evaluate({
        resolution: { ...dualRoutes, routes: [subscriptionRoute] },
        syntheticAuthProviderRefs: ["codex"],
      }),
    ).toMatchObject({ availability: undefined, evidence: "synthetic" });
  });

  it("does not let invalid automatic profile evidence block synthetic Codex ownership", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:invalid": { type: "api_key", provider: "openai", key: "" },
        }),
        syntheticAuthProviderRefs: ["codex"],
      }),
    ).toMatchObject({
      availability: undefined,
      evidence: "synthetic",
      routeResolution: dualRoutes,
    });
  });

  it("does not let Codex synthetic auth own an OpenClaw-only route", () => {
    const openClawOnlyRoute = {
      ...platformRoute,
      runtimePolicy: { compatibleIds: ["openclaw"] },
    } satisfies ProviderModelRouteCandidate;
    expect(
      evaluate({
        resolution: {
          kind: "routes",
          defaultRuntimeId: "openclaw",
          routes: [openClawOnlyRoute],
        },
        syntheticAuthProviderRefs: ["codex"],
      }),
    ).toMatchObject({
      availability: false,
      selectedRoute: openClawOnlyRoute,
    });
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
  it("passes one physical route group to auth selection for an unknown model", () => {
    const resolveRoutes = vi.fn(() => dualRoutes);
    mockRouteResolverFactory((() => resolveRoutes) as typeof createOpenAIModelRoutesResolver);
    const resolver = resolverWith({
      cfg: { auth: { order: { openai: ["openai:chatgpt", "openai:platform"] } } },
      authStore: authStore({
        "openai:platform": createApiKeyCredential("openai", "platform-key"),
        "openai:chatgpt": openAiOAuthProfile(),
      }),
    });
    const observedRoutes = [
      { api: "openai-chatgpt-responses" as const, baseUrl: subscriptionRoute.baseUrl },
      { api: "openai-responses" as const, baseUrl: platformRoute.baseUrl },
    ];

    expect(
      resolver.evaluateModelAuth("openai", {
        modelId: "gpt-future-observed",
        observedRoutes,
      }),
    ).toMatchObject({
      availability: true,
      selectedProfileId: "openai:chatgpt",
      selectedRoute: subscriptionRoute,
    });
    expect(resolveRoutes).toHaveBeenCalledOnce();
    expect(resolveRoutes).toHaveBeenCalledWith({
      modelId: "gpt-future-observed",
      observedRoutes,
    });
  });
});

describe("credential readiness and retry reasons", () => {
  const catalogRef = { source: "store", provider: "default", id: "CATALOG_KEY" } as const;
  afterEach(clearRuntimeConfigSnapshot);

  function readiness(cfg: OpenClawConfig, store = authStore()) {
    return resolverWith({ cfg, authStore: store });
  }

  it.each([
    { name: "resolved profile collision", key: "bound", available: true },
    { name: "resolved malformed syntax", key: "$not-a-template", available: true },
    { name: "pending env provenance", key: "ollama-local", pending: true, available: true },
    { name: "literal profile binding", key: "bound", literal: true, available: false },
    { name: "literal local marker", key: "ollama-local", literal: true, available: undefined },
    { name: "literal env marker", key: "OPENAI_API_KEY", literal: true, available: false },
    { name: "literal malformed syntax", key: "$not-a-template", literal: true, available: false },
    { name: "missing snapshot", key: "ollama-local", snapshot: "absent", available: undefined },
    { name: "unresolved snapshot", snapshot: "unresolved", available: undefined },
    { name: "empty snapshot material", key: "", available: undefined },
    { name: "foreign source", key: "ollama-local", snapshot: "foreign", available: undefined },
    { name: "replaced source", key: "ollama-local", snapshot: "replaced", available: undefined },
    { name: "empty profile order", key: "ollama-local", order: true, available: true },
    { name: "explicit lock", key: "ollama-local", locked: true, available: false },
  ])(
    "preserves source ownership for $name",
    ({ key, literal, pending, snapshot, order, locked, available }) => {
      const sourceConfig = {
        ...providerConfig("acme", {
          baseUrl: "https://acme.example/v1",
          apiKey: literal ? key : pending ? "${PENDING_KEY}" : catalogRef,
        }),
        ...(order ? { auth: { order: { acme: [] } } } : {}),
      };
      if (pending) {
        setConfigResolutionFacts(
          sourceConfig,
          createConfigResolutionFacts(
            [],
            new Map([["models.providers.acme.apiKey", "PENDING_KEY"]]),
          ),
        );
      }
      const runtimeConfig = structuredClone(sourceConfig);
      if (snapshot !== "unresolved") {
        runtimeConfig.models.providers.acme!.apiKey = key;
      }
      const store = authStore({
        bound: { type: "api_key", provider: "other", key: "profile-key" },
      });
      if (snapshot !== "absent") {
        setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      }
      const cfg =
        snapshot === "absent" || snapshot === "foreign" || snapshot === "replaced"
          ? structuredClone(sourceConfig)
          : runtimeConfig;
      if (snapshot === "foreign") {
        cfg.models.providers.acme!.baseUrl = "https://foreign.example/v1";
      }
      if (snapshot === "replaced") {
        const replacement = structuredClone(sourceConfig);
        replacement.models.providers.acme!.apiKey = { ...catalogRef, id: "REPLACEMENT_KEY" };
        setRuntimeConfigSnapshot(runtimeConfig, replacement);
      }
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
    expect(evaluate({ store, ref: { preferredProfileId: "first" } })).toMatchObject({
      availability: false,
      unavailableReason: "cooldown",
      unavailableUntil: until,
    });
    expect(evaluate({ store, ref: { pinnedProfileId: "invalid" } })).toMatchObject({
      availability: false,
      unavailableReason: "auth-failed",
    });
  });

  it("hides a cooling inline key while preserving a healthy profile fallback", () => {
    const store = authStore();
    const provider = "anthropic-local";
    const cfg = providerConfig(provider, {
      apiKey: "demo-key",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    const availability = () =>
      readiness(cfg, store).evaluateModelAuth(provider, { modelId: "demo-model" }).availability;

    expect(availability()).toBe(true);
    store.usageStats = {
      "inline-api-key:anthropic-local": {
        disabledUntil: Date.now() + 60_000,
        disabledReason: "billing",
      },
    };
    expect(availability()).toBe(false);
    store.profiles["test-profile"] = createApiKeyCredential("anthropic-local", "profile-key");
    expect(availability()).toBe(true);
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
