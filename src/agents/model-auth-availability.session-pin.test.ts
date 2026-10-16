import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import {
  createApiKeyCredential as key,
  createOAuthRefreshCredential as oauth,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { LEGACY_OAUTH_REF_PROVIDER } from "./auth-profiles/legacy-oauth-ref.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  dualRoutes,
  evaluate,
  routeResolverFactory,
} from "./model-auth-availability.test-support.js";
import { providerConfig } from "./model-auth.fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";

function readiness(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  options: Partial<Parameters<typeof createModelAuthAvailabilityResolver>[0]> = {},
) {
  return createModelAuthAvailabilityResolver({
    cfg,
    authStore: store,
    env: {},
    preparedRuntimeAuthStore: authStore(),
    ...options,
  });
}

function preparePin(
  provider: string,
  config: OpenClawConfig,
  store: AuthProfileStore,
  pin: string,
  sessionAuthProfileSource: "user" | "user-link" = "user",
  modelId = "gpt-5.5",
) {
  return prepareAgentRuntimeAuth({
    provider,
    config,
    authProfileStore: store,
    sessionAuthProfileId: pin,
    sessionAuthProfileSource,
    modelId,
    env: {},
  });
}

function unresolvedOAuth(provider: string) {
  return oauth({
    provider,
    access: "",
    refresh: "",
    expires: 0,
    oauthRef: {
      source: "openclaw-credentials",
      provider: LEGACY_OAUTH_REF_PROVIDER,
      id: "00000000000000000000000000000000",
    },
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
      const store = authStore({ shared: key(provider, "synthetic-shared") });
      const env = { SYNTHETIC_PROVIDER_KEY: "synthetic-ref" };
      const runtime = prepareAgentRuntimeAuth({
        provider,
        modelId: "gpt-5.5",
        config,
        env,
        authProfileStore: store,
      });
      expect(runtime.attempts.map((attempt) => attempt.kind)).toEqual(["direct"]);
      expect(
        readiness(config, store, {
          env,
          routeResolverFactory: routeResolverFactory(provider === "openai" ? dualRoutes : null),
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
      [shared]: key(provider, "synthetic-shared"),
    });
    if (state === "cooldown") {
      store.usageStats = { [pin]: { cooldownUntil: Date.now() + 600_000 } };
    }
    const expected = state === "ready" || state === "refresh-needed" ? [pin, shared] : [shared];
    const runtime = preparePin(provider, config, store, pin, personal ? "user-link" : "user");
    expect(runtime.attempts.map((attempt) => attempt.profileId)).toEqual(expected);
    const result = readiness(config, store, {
      routeResolverFactory: routeResolverFactory(provider === "openai" ? dualRoutes : null),
    }).evaluateModelAuth(provider, {
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
      const store = authStore({ [shared]: key(provider, "synthetic-shared") });
      if (state !== "missing") {
        store.profiles[pin] =
          state === "unresolved-oauth"
            ? unresolvedOAuth(provider)
            : {
                type: "token",
                provider: state === "wrong-provider" ? "other" : provider,
                token: "synthetic-invalid",
                expires: state === "expired-token" ? 1 : Date.now() + 600_000,
              };
      }
      expect(() => preparePin(provider, config, store, pin)).toThrow(
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
      expect(
        readiness(config, store, {
          routeResolverFactory: routeResolverFactory(provider === "openai" ? dualRoutes : null),
        }).evaluateModelAuth(provider, { modelId: "gpt-5.5", pinnedProfileId: pin }),
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
        [pin]: oauth(),
        ...(selection === "required" ? { "openai:shared": key("openai", "synthetic-key") } : {}),
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
      const store = authStore(hasProfiles ? { "openai:chatgpt": oauth() } : {});
      if (hasProfiles && state !== "direct-fallback") {
        store.profiles["openai:platform"] =
          state === "unread"
            ? {
                type: "api_key",
                provider: "openai",
                keyRef: { source: "env", provider: "default", id: "UNREAD_KEY" },
              }
            : key("openai", "synthetic-key");
      }
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
    ["openai:platform", undefined, "api-key"],
    ["openai:chatgpt", "openai:platform", "subscription"],
  ] as const)(
    "keeps %s ahead of inherited and automatic billing preferences",
    (pinnedProfile, primaryProfile, requirement) => {
      const cfg: OpenClawConfig = primaryProfile
        ? {
            agents: { defaults: { model: `openai/gpt-5.4@${primaryProfile}` } },
            auth: { profiles: { "openai:platform": { provider: "openai", mode: "api_key" } } },
          }
        : {};
      const store = authStore({
        "openai:platform": key("openai", "fixture-key"),
        "openai:chatgpt": oauth(),
      });
      const result = createModelAuthAvailabilityResolver({
        cfg,
        authStore: store,
        env: {},
      }).evaluateModelAuth("openai", { modelId: "gpt-5.5", pinnedProfileId: pinnedProfile });
      expect(result).toMatchObject({
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
      const store = authStore({ "acme:shared": key(provider, "synthetic-shared") });
      if (state !== "absent") {
        store.profiles[pin] =
          state === "wrong-mode"
            ? key(provider, "synthetic-key")
            : {
                type: "token",
                provider: state === "wrong-provider" ? "other" : provider,
                token: "synthetic-token",
                expires: state === "expired-token" ? 1 : Date.now() + 600_000,
              };
      }
      const prepare = () => preparePin(provider, config, store, pin, "user", "synthetic-model");
      if (state === "absent") {
        expect(prepare().attempts[0]?.profileId).toBe(pin);
      } else {
        expect(prepare).toThrow("is not configured");
      }
      expect(
        readiness(config, store, {
          routeResolverFactory: routeResolverFactory(null),
        }).evaluateModelAuth(provider, { modelId: "synthetic-model", pinnedProfileId: pin }),
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
    const runtimeStore = authStore({ [pin]: oauth({ provider }) });
    expect(
      preparePin(provider, config, runtimeStore, pin, "user", "synthetic-model").attempts.map(
        (attempt) => attempt.profileId,
      ),
    ).toEqual([pin]);
    expect(
      readiness(config, store, {
        preparedRuntimeAuthStore: runtimeStore,
        routeResolverFactory: routeResolverFactory(null),
      }).evaluateModelAuth(provider, { modelId: "synthetic-model", pinnedProfileId: pin }),
    ).toMatchObject({ availability: true, selectedProfileId: pin });
  });
});

it.each(["automatic", "pinned", "unavailable", "no-preference"] as const)(
  "keeps current %s selection authoritative over past API-route success",
  (selection) => {
    const subscriptionSelected = selection === "automatic";
    const store = authStore({
      "openai:metered": key("openai", "synthetic-api-key"),
      "openai:subscription": oauth(
        selection === "unavailable" ? { access: "", refresh: "", expires: 1 } : {},
      ),
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
    const subscription = "openai:subscription";
    const store = authStore({ [subscription]: oauth() }, { openai: [subscription] });
    const availability = createModelAuthAvailabilityResolver({
      cfg: config,
      authStore: store,
      env: {},
    }).evaluateModelAuth("openai", { modelId: "gpt-5.5" });
    expect.soft(availability).toMatchObject({
      availability: true,
      selectedRoute: { authRequirement: explicitApi ? "api-key" : "subscription" },
    });
    expect
      .soft(availability.selectedProfileId)
      .toBe(explicitApi ? undefined : "openai:subscription");
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
