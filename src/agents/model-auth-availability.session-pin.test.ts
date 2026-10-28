import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createApiKeyCredential as apiKey,
  createOAuthRefreshCredential as oauth,
  createUnresolvedOAuthCredential as unresolvedOAuth,
} from "./auth-profiles/credential-fixtures.test-support.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  dualRoutes,
  evaluate,
  routeResolverFactory,
  mockRouteResolverFactory,
} from "./model-auth-availability.test-support.js";
import { providerConfig } from "./model-auth.fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

const subscription = (overrides: Parameters<typeof oauth>[0] = {}) =>
  oauth({
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 600_000,
    ...overrides,
  });

function readiness(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  preparedRuntimeAuthStore = authStore(),
) {
  return createModelAuthAvailabilityResolver({
    cfg,
    authStore: store,
    env: {},
    preparedRuntimeAuthStore,
  });
}

describe.each(["acme", "openai"])("%s session account readiness", (provider) => {
  it.each(["api-key", "oauth"] as const)(
    "requires provider SecretRef %s auth instead of a shared profile",
    (mode) => {
      const config = providerConfig(provider, {
        auth: mode,
        apiKey: { source: "env", provider: "default", id: "SYNTHETIC_PROVIDER_KEY" },
      });
      const store = authStore({ shared: apiKey(provider, "synthetic-shared") });
      const env = { SYNTHETIC_PROVIDER_KEY: "synthetic-ref" };
      const runtime = prepareAgentRuntimeAuth({
        provider,
        modelId: "gpt-5.5",
        config,
        env,
        authProfileStore: store,
      });
      expect(runtime.attempts.map((attempt) => attempt.kind)).toEqual(["direct"]);
      mockRouteResolverFactory(routeResolverFactory(provider === "openai" ? dualRoutes : null));
      expect(
        createModelAuthAvailabilityResolver({
          cfg: config,
          authStore: store,
          env,
          preparedRuntimeAuthStore: authStore(),
        }).evaluateModelAuth(provider, { modelId: "gpt-5.5" }),
      ).toMatchObject({ availability: true, evidence: "provider-config", selectedAuthMode: mode });
    },
  );

  it.each([
    { personal: false, state: "ready" },
    { personal: true, state: "ready" },
    { personal: false, state: "expired-oauth" },
    { personal: true, state: "refresh-needed" },
    { personal: false, state: "cooldown" },
    { personal: true, state: "cooldown" },
  ])("matches runtime shared failover for $state (personal=$personal)", ({ personal, state }) => {
    const pin = personal ? "personal:owner:account" : `${provider}:selected`;
    const shared = `${provider}:shared`;
    const config: OpenClawConfig = { auth: { order: { [provider]: [shared] } } };
    const store = authStore({
      [pin]: oauth({
        provider,
        access: "synthetic-personal",
        refresh: state === "expired-oauth" ? "" : "synthetic-refresh",
        expires: state === "expired-oauth" || state === "refresh-needed" ? 1 : Date.now() + 600_000,
      }),
      [shared]: apiKey(provider, "synthetic-shared"),
    });
    if (state === "cooldown") {
      store.usageStats = { [pin]: { cooldownUntil: Date.now() + 600_000 } };
    }
    const expected = state === "ready" || state === "refresh-needed" ? [pin, shared] : [shared];
    const runtime = prepareAgentRuntimeAuth({
      provider,
      modelId: "gpt-5.5",
      config,
      env: {},
      authProfileStore: store,
      sessionAuthProfileId: pin,
      sessionAuthProfileSource: personal ? "user-link" : "user",
    });
    expect(runtime.attempts.map((attempt) => attempt.profileId)).toEqual(expected);
    mockRouteResolverFactory(routeResolverFactory(provider === "openai" ? dualRoutes : null));
    const result = readiness(config, store).evaluateModelAuth(provider, {
      modelId: "gpt-5.5",
      preferredProfileId: pin,
      pinnedProfileId: pin,
    });
    expect(result).toMatchObject({
      availability: true,
      selectedProfileId: state === "refresh-needed" && provider !== "openai" ? shared : expected[0],
    });
  });

  it.each(["expired-token", "missing", "wrong-provider", "unresolved-oauth"])(
    "rejects an invalid %s pin before considering shared credentials",
    (state) => {
      const pin = `${provider}:selected`;
      const shared = `${provider}:shared`;
      const config: OpenClawConfig = { auth: { order: { [provider]: [shared] } } };
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          ...(state === "missing"
            ? {}
            : {
                [pin]:
                  state === "unresolved-oauth"
                    ? unresolvedOAuth(provider)
                    : {
                        type: "token" as const,
                        provider: state === "wrong-provider" ? "other" : provider,
                        token: "synthetic-invalid",
                        expires: state === "expired-token" ? 1 : Date.now() + 600_000,
                      },
              }),
          [shared]: apiKey(provider, "synthetic-shared"),
        },
      };
      expect(() =>
        prepareAgentRuntimeAuth({
          provider,
          modelId: "gpt-5.5",
          config,
          env: {},
          authProfileStore: store,
          sessionAuthProfileId: pin,
          sessionAuthProfileSource: "user",
        }),
      ).toThrow(
        state === "missing"
          ? expect.objectContaining({
              code: "selected_auth_profile_unavailable",
              message: `Selected auth profile "${pin}" is unavailable.`,
              reason: "auth",
              status: undefined,
              provider,
              profileId: pin,
            })
          : "is not configured",
      );
      mockRouteResolverFactory(routeResolverFactory(provider === "openai" ? dualRoutes : null));
      expect(
        readiness(config, store).evaluateModelAuth(provider, {
          modelId: "gpt-5.5",
          pinnedProfileId: pin,
        }),
      ).toMatchObject({ availability: false, unavailableReason: "auth-failed" });
    },
  );
});

describe("session account pin admission", () => {
  it.each(["automatic", "ordered", "pinned", "required", "configured"] as const)(
    "reports an authoritative route rejection for %s OAuth on a Platform-only model",
    (selection) => {
      const pin = "openai:chatgpt";
      const cfg: OpenClawConfig =
        selection === "ordered"
          ? { auth: { order: { openai: [pin] } } }
          : selection === "configured"
            ? providerConfig("openai", { auth: "oauth" })
            : {};
      const store = authStore({
        [pin]: subscription(),
        ...(selection === "required" ? { "openai:shared": apiKey("openai", "synthetic-key") } : {}),
      });
      const result = readiness(cfg, store).evaluateModelAuth("openai", {
        modelId: "CHAT-LATEST",
        ...(selection === "pinned" ? { pinnedProfileId: pin } : {}),
        ...(selection === "required" ? { requiredProfileId: pin } : {}),
      });

      expect(result).toMatchObject({
        availability: false,
        availabilityAuthoritative: true,
        unavailableReason: "auth-failed",
        routeResolution: { kind: "routes" },
      });
    },
  );

  it.each([
    { state: "missing", availability: false },
    { state: "required-missing", availability: false },
    { state: "unread", availability: undefined },
    { state: "cooldown", availability: false },
    { state: "shared-fallback", availability: true },
    { state: "direct-fallback", availability: true },
  ] as const)(
    "keeps $state authentication distinct from route incompatibility",
    ({ state, availability }) => {
      const hasProfiles = state !== "missing" && state !== "required-missing";
      const store = authStore(
        hasProfiles
          ? {
              "openai:chatgpt": subscription(),
              ...(state !== "direct-fallback"
                ? {
                    "openai:platform": {
                      type: "api_key",
                      provider: "openai",
                      ...(state === "unread"
                        ? { keyRef: { source: "env", provider: "default", id: "UNREAD_KEY" } }
                        : { key: "synthetic-key" }),
                    },
                  }
                : {}),
            }
          : {},
      );
      if (state === "cooldown") {
        store.usageStats = { "openai:platform": { cooldownUntil: Date.now() + 600_000 } };
      }
      const cfg: OpenClawConfig =
        state === "direct-fallback" ? providerConfig("openai", { apiKey: "synthetic-direct" }) : {};
      const result = readiness(cfg, store).evaluateModelAuth("openai", {
        modelId: "chat-latest",
        ...(state === "shared-fallback" ? { pinnedProfileId: "openai:chatgpt" } : {}),
        ...(state === "required-missing" ? { requiredProfileId: "openai:missing" } : {}),
      });

      expect(result.availability).toBe(availability);
      expect(result.availabilityAuthoritative).toBeUndefined();
      if (state === "cooldown") {
        expect(result.unavailableReason).toBe("cooldown");
      }
      if (state === "shared-fallback") {
        expect(result.selectedProfileId).toBe("openai:platform");
      }
    },
  );

  it.each([
    { pinnedProfile: "openai:platform", primaryProfile: undefined, requirement: "api-key" },
    {
      pinnedProfile: "openai:chatgpt",
      primaryProfile: "openai:platform",
      requirement: "subscription",
    },
  ])(
    "keeps $pinnedProfile ahead of inherited and automatic billing preferences",
    ({ pinnedProfile, primaryProfile, requirement }) => {
      expect(
        createModelAuthAvailabilityResolver({
          cfg: primaryProfile
            ? {
                agents: { defaults: { model: `openai/gpt-5.4@${primaryProfile}` } },
                auth: { profiles: { "openai:platform": { provider: "openai", mode: "api_key" } } },
              }
            : {},
          env: {},
          authStore: authStore({
            "openai:platform": apiKey("openai", "fixture-key"),
            "openai:chatgpt": oauth({ access: "fixture-access", refresh: "fixture-refresh" }),
          }),
        }).evaluateModelAuth("openai", {
          modelId: "gpt-5.5",
          pinnedProfileId: pinnedProfile,
          preferredProfileId:
            pinnedProfile === "openai:platform" ? "openai:chatgpt" : "openai:platform",
        }),
      ).toMatchObject({
        availability: true,
        selectedProfileId: pinnedProfile,
        selectedRoute: { authRequirement: requirement },
      });
    },
  );

  it.each(["absent", "wrong-provider", "wrong-mode", "expired-token"])(
    "validates an AWS SDK declaration with %s stored credentials",
    (state) => {
      const provider = "acme";
      const pin = "acme:sdk";
      const config: OpenClawConfig = {
        auth: {
          profiles: { [pin]: { provider, mode: "aws-sdk" } },
          order: { [provider]: ["acme:shared"] },
        },
        ...providerConfig(provider, { auth: "aws-sdk" }),
      };
      const store: AuthProfileStore = {
        version: 1,
        profiles: {
          ...(state === "absent"
            ? {}
            : {
                [pin]:
                  state === "wrong-mode"
                    ? apiKey(provider, "synthetic-key")
                    : {
                        type: "token" as const,
                        provider: state === "wrong-provider" ? "other" : provider,
                        token: "synthetic-token",
                        expires: state === "expired-token" ? 1 : Date.now() + 600_000,
                      },
              }),
          "acme:shared": apiKey(provider, "synthetic-shared"),
        },
      };
      const prepare = () =>
        prepareAgentRuntimeAuth({
          provider,
          modelId: "synthetic-model",
          config,
          env: {},
          authProfileStore: store,
          sessionAuthProfileId: pin,
          sessionAuthProfileSource: "user",
        });
      if (state === "absent") {
        expect(prepare().attempts[0]?.profileId).toBe(pin);
      } else {
        expect(prepare).toThrow("is not configured");
      }
      mockRouteResolverFactory(routeResolverFactory(null));
      expect(
        readiness(config, store).evaluateModelAuth(provider, {
          modelId: "synthetic-model",
          pinnedProfileId: pin,
        }),
      ).toMatchObject(
        state === "absent"
          ? { availability: true, selectedProfileId: pin, selectedAuthMode: "aws-sdk" }
          : { availability: false, unavailableReason: "auth-failed" },
      );
    },
  );

  it("admits a pinned OAuth reference from its prepared runtime credential", () => {
    const provider = "acme";
    const pin = "acme:hydrated";
    const config: OpenClawConfig = {};
    const store = authStore({ [pin]: unresolvedOAuth(provider) });
    const runtimeStore = authStore({ [pin]: subscription({ provider }) });
    expect(
      prepareAgentRuntimeAuth({
        provider,
        modelId: "synthetic-model",
        config,
        env: {},
        authProfileStore: runtimeStore,
        sessionAuthProfileId: pin,
        sessionAuthProfileSource: "user",
      }).attempts.map((attempt) => attempt.profileId),
    ).toEqual([pin]);
    mockRouteResolverFactory(routeResolverFactory(null));
    expect(
      readiness(config, store, runtimeStore).evaluateModelAuth(provider, {
        modelId: "synthetic-model",
        pinnedProfileId: pin,
      }),
    ).toMatchObject({ availability: true, selectedProfileId: pin });
  });
});

describe("OpenAI materialized route readiness", () => {
  it.each(["automatic", "pinned", "unavailable", "no-preference"] as const)(
    "keeps current %s selection authoritative over past API-route success",
    (selection) => {
      const subscriptionSelected = selection === "automatic";
      const store = authStore({
        "openai:metered": apiKey("openai", "synthetic-api-key"),
        "openai:subscription": subscription({
          access: selection === "unavailable" ? "" : "synthetic-access",
          refresh: selection === "unavailable" ? "" : "synthetic-refresh",
          expires: selection === "unavailable" ? 1 : Date.now() + 600_000,
        }),
      });
      const result = evaluate({
        store,
        resolution: {
          ...dualRoutes,
          preferredAuthRequirement: selection === "no-preference" ? undefined : "subscription",
        },
        ref: {
          modelId: "gpt-5.4-mini",
          ...(selection === "pinned" ? { pinnedProfileId: "openai:metered" } : {}),
        },
        preparedRuntimeAuthMaterializations: [
          {
            provider: "openai",
            modelId: "gpt-5.4-mini",
            modelApi: "openai-responses",
            modelBaseUrl: "https://api.openai.com/v1",
            requestTransportOverrides: "none",
            authMode: "api-key",
            runtimeOwnerId: "codex",
            authProfileId: "openai:metered",
          },
        ],
      });
      expect(result).toMatchObject({
        availability: true,
        selectedProfileId: subscriptionSelected ? "openai:subscription" : "openai:metered",
        selectedRoute: { authRequirement: subscriptionSelected ? "subscription" : "api-key" },
        evidence: subscriptionSelected || selection === "pinned" ? "profile" : "runtime",
      });
    },
  );
});

describe("declared OpenAI fallback routing", () => {
  it.each(["profile-only", "plain-literal-fallback", "explicit-api-auth"] as const)(
    "keeps planner and availability aligned for %s",
    (shape) => {
      const explicitApi = shape === "explicit-api-auth";
      const config: OpenClawConfig =
        shape === "profile-only"
          ? {}
          : providerConfig("openai", {
              apiKey: "synthetic-direct-key",
              auth: explicitApi ? "api-key" : undefined,
            });
      const store = authStore(
        {
          "openai:subscription": subscription(),
        },
        { openai: ["openai:subscription"] },
      );
      const availability = createModelAuthAvailabilityResolver({
        cfg: config,
        authStore: store,
        env: {},
      }).evaluateModelAuth("openai", { modelId: "gpt-5.5" });
      expect
        .soft({
          available: availability.availability,
          profileId: availability.selectedProfileId,
          requirement: availability.selectedRoute?.authRequirement,
        })
        .toEqual({
          available: true,
          profileId: explicitApi ? undefined : "openai:subscription",
          requirement: explicitApi ? "api-key" : "subscription",
        });
      const preparation = prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.5",
        config,
        env: {},
        authProfileStore: store,
        harnessId: "openclaw",
        harnessRuntime: "openclaw",
      });
      const profileAttempt = ["profile", "openai:subscription", "subscription", undefined];
      expect(
        preparation.attempts.map((attempt) => [
          attempt.kind,
          attempt.profileId,
          attempt.plan.modelRoute?.authRequirement,
          attempt.requiresPriorProfileAttempt,
        ]),
      ).toEqual(
        explicitApi
          ? [["direct", undefined, "api-key", false]]
          : shape === "plain-literal-fallback"
            ? [profileAttempt, ["direct", undefined, "api-key", true]]
            : [profileAttempt],
      );
    },
  );
});
