import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { createOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../failover/error.js";
import { resolveAgentHarnessPreparedAuthSupport } from "../harness/support.js";
import { providerConfig } from "../model-auth.fixtures.test-support.js";
import { getApiKeyForModelCore } from "../model-auth.js";
import {
  apiKey,
  apiRoute,
  authModel,
  authStore,
  codexHarness,
  createPreparationFixture,
  nativeCodex,
  oauth,
  oneProfile,
  openAIConfig,
  platform,
  setProfileCooldown,
  subscription,
  token,
  userPin,
} from "./auth-fixtures.test-support.js";
import {
  agentRuntimeAuthPlanMatchesTarget,
  canRunPreparedAgentRuntimeAuthAttempt,
  prepareAgentRuntimeAuth,
  preparedAgentRuntimeProfileAttemptHasCandidate,
} from "./prepare-auth.js";
import { prepareAuthFixture } from "./prepare-auth.test-support.js";

const { prepare, preparePlan, expectAuthError } = createPreparationFixture(prepareAuthFixture);
type Params = Parameters<typeof prepare>[0];
const xaiKey = (key: string) => createApiKeyCredential("xai", key);
const pair = () => ({ "openai:platform": apiKey(), "openai:chatgpt": oauth() });

// Provider-hook behavior is covered by its owner suites.
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

it.each([
  [
    "token-sharing OAuth uses public Responses",
    () => ({
      ...platform,
      ...codexHarness,
      ...userPin("openai:shared"),
      profiles: oneProfile("openai:shared", oauth({ authFlow: "chatgpt-token-sharing" })),
    }),
    {
      forwardedAuthProfileId: "openai:shared",
      selectedAuthMode: "oauth",
      selectedAuthFlow: "chatgpt-token-sharing",
      modelRoute: { ...apiRoute, baseUrl: "https://api.openai.com/v1" },
    },
  ],
  [
    "provider preference filters invalid profiles without locking fallback",
    () => ({
      provider: "xai",
      modelId: "grok-4",
      config: { auth: { profiles: { "xai:invalid": { provider: "xai", mode: "oauth" } } } },
      profiles: {
        "xai:invalid": xaiKey("invalid-key"),
        "xai:p1": xaiKey("p1-key"),
        "xai:p2": xaiKey("p2-key"),
      },
      order: { xai: ["xai:invalid", "xai:p1", "xai:p2"] },
      resolveProviderPreferredProfileId: () => "xai:p2",
    }),
    {
      forwardedAuthProfileId: "xai:p2",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["xai:p2", "xai:p1"],
    },
  ],
  [
    "provider token binding outranks configured auth and order",
    () => ({
      ...platform,
      config: openAIConfig({ auth: "api-key", apiKey: "openai:bound" }),
      profiles: {
        "openai:bound": token(undefined, Date.now() + 60_000),
        "openai:platform": apiKey(),
      },
      order: { openai: ["openai:platform", "openai:bound"] },
    }),
    {
      forwardedAuthProfileId: "openai:bound",
      forwardedAuthProfileSource: "auto",
      forwardedAuthProfileCandidateIds: ["openai:bound"],
      selectedAuthMode: "token",
      modelRoute: { api: "openai-chatgpt-responses", authRequirement: "subscription" },
    },
  ],
  [
    "AWS SDK mode outranks provider profile binding",
    () => ({
      ...platform,
      config: openAIConfig({ auth: "aws-sdk", apiKey: "openai:bound" }),
      profiles: oneProfile("openai:bound", token(undefined, Date.now() + 60_000)),
    }),
    { forwardedAuthProfileId: undefined, selectedAuthMode: "aws-sdk", modelRoute: apiRoute },
  ],
  [
    "local provider marker is synthetic auth",
    () => ({
      provider: "ollama-remote",
      modelId: "qwen3.5:27b",
      config: providerConfig("ollama-remote", {
        api: "ollama",
        apiKey: "ollama-local",
        baseUrl: "http://192.168.178.122:11434",
      }),
    }),
    { credentialSource: { kind: "direct", evidence: "synthetic", authorization: "declared" } },
  ],
] satisfies [string, () => Params, object][])("%s", (_name, fixture, expected) => {
  expect(preparePlan(fixture())).toMatchObject(expected);
});

it("non-Codex harnesses honor no-host-auth policy", () => {
  const plan = preparePlan({
    provider: "xai",
    modelId: "grok-4",
    config: providerConfig("xai", { auth: "api-key", apiKey: "xai-key" }),
    profiles: { "xai:auto": xaiKey("profile-key") },
    sessionAuthProfileId: "xai:auto",
    sessionAuthProfileSource: "auto",
    harnessId: "native-remote",
    harnessRuntime: "native-remote",
    allowHarnessAuthProfileForwarding: false,
  });
  expect(plan.forwardedAuthProfileId).toBeUndefined();
  expect(plan.selectedAuthMode).toBeUndefined();
});

it.each([
  [
    "user pins cannot cross incompatible routes",
    () => ({
      ...subscription,
      ...userPin("openai:platform"),
      config: openAIConfig({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }),
      profiles: oneProfile("openai:platform", apiKey()),
    }),
    /no route-compatible authentication source/iu,
  ],
  [
    "official authored routes reject unvalidated native auth",
    () => ({
      ...platform,
      ...codexHarness,
      harnessAuthBootstrap: "harness",
      allowHarnessAuthProfileForwarding: false,
      config: openAIConfig({
        auth: "api-key",
        apiKey: "configured-platform-key",
        baseUrl: "https://api.openai.com/v1",
      }),
      env: { OPENAI_API_KEY: "ambient-platform-key" },
      profiles: oneProfile("openai:chatgpt", oauth()),
      order: { openai: ["openai:chatgpt"] },
      sessionAuthProfileId: "openai:chatgpt",
      sessionAuthProfileSource: "auto",
    }),
    /route-compatible authentication source/u,
  ],
  [
    "locked profile requires a harness accepting host auth",
    () => ({
      ...platform,
      ...codexHarness,
      ...userPin("openai:work"),
      profiles: oneProfile("openai:work", apiKey()),
      allowHarnessAuthProfileForwarding: false,
    }),
    /native account instead/u,
  ],
  [
    "incompatible provider binding cannot borrow ordered auth",
    () => ({
      ...platform,
      config: openAIConfig({ apiKey: "openai:oauth" }),
      profiles: { "openai:oauth": oauth(), "openai:platform": apiKey() },
      order: { openai: ["openai:platform"] },
    }),
    /not a compatible bearer profile/u,
  ],
  [
    "ambient OAuth cannot follow incompatible Platform profiles",
    () => ({
      config: openAIConfig({ auth: "oauth" }),
      env: { OPENAI_API_KEY: "ambient-oauth-token" },
      profiles: oneProfile("openai:platform", apiKey("profile-platform-key")),
      order: { openai: ["openai:platform"] },
    }),
    "Explicit auth order for openai has no usable profiles.",
  ],
  [
    "configured auth cannot contradict authored routes",
    () => ({
      ...platform,
      config: openAIConfig({
        auth: "oauth",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      }),
    }),
    /not compatible/u,
  ],
] satisfies [string, () => Params, RegExp | string][])("%s", (_name, fixture, error) => {
  expectAuthError(fixture()).toThrow(error);
});

it("does not defer identity-only login to native Codex", () => {
  expect(() =>
    prepareAgentRuntimeAuth({
      ...platform,
      ...codexHarness,
      harnessAuthBootstrap: "harness",
      authProfileStore: authStore(
        oneProfile("openai:identity", oauth({ authFlow: "chatgpt-identity" })),
      ),
    }),
  ).toThrow(/No route-compatible authentication source/);
});

it.each([
  { provider: "anthropic", mode: "api_key" as const },
  { provider: "openai", mode: "oauth" as const },
])("rejects conflicting binding metadata $provider/$mode", ({ mode, provider }) => {
  expectAuthError({
    config: {
      auth: { profiles: { "openai:bound": { provider, mode } } },
      ...openAIConfig({ apiKey: "openai:bound" }),
    },
    profiles: oneProfile("openai:bound", apiKey("bound-platform-key")),
  }).toThrow(/no usable credentials/u);
});

it("keeps subscription pins ahead of inherited Platform billing", () => {
  const prepared = prepareAgentRuntimeAuth({
    ...platform,
    ...userPin("openai:chatgpt"),
    config: {
      agents: { defaults: { model: "openai/gpt-5.4@openai:platform" } },
      auth: { profiles: { "openai:platform": { provider: "openai", mode: "api_key" } } },
    },
    authProfileStore: authStore({ ...pair(), "openai:platform": apiKey("fixture-key") }),
  });
  expect(prepared.plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: { authRequirement: "subscription" },
  });
  expect(prepared.attempts.map((a) => a.profileId)).toEqual(["openai:chatgpt"]);
});

it("keeps materialized endpoints on their credential provider", () => {
  const config = providerConfig("arcee", { baseUrl: "https://openrouter.ai/api/v1" });
  expect(
    preparePlan({
      provider: "arcee",
      modelId: "trinity-large-thinking",
      modelApi: "openai-completions",
      modelBaseUrl: "https://api.arcee.ai/api/v1",
      config,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "arcee",
            providers: ["arcee"],
            providerAuthAliases: {
              arcee: { provider: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
            },
          },
        ],
      }),
      profiles: {
        "arcee:direct": createApiKeyCredential("arcee", "direct-model-key"),
        "openrouter:routed": createApiKeyCredential("openrouter", "router-model-key"),
      },
    }),
  ).toMatchObject({ providerForAuth: "arcee", forwardedAuthProfileId: "arcee:direct" });
  expect(config.models?.providers?.arcee?.baseUrl).toBe("https://openrouter.ai/api/v1");
});

it.each(["cooldown", "missing"] as const)("fails closed for generic %s profiles", (failure) => {
  const cooldown = failure === "cooldown";
  const store = authStore(
    cooldown
      ? { "xai:p1": xaiKey("p1-key"), "xai:p2": xaiKey("p2-key") }
      : { "xai:backup": xaiKey("backup-key") },
    cooldown ? { xai: ["xai:p1", "xai:p2"] } : undefined,
  );
  if (cooldown) {
    setProfileCooldown(store, "xai:p1", { cooldownReason: "rate_limit", cooldownModel: "grok-4" });
    store.usageStats!["xai:p2"] = { cooldownUntil: Date.now() + 60_000 };
  }
  expectAuthError({
    provider: "xai",
    modelId: "grok-4",
    authProfileStore: store,
    ...(cooldown
      ? { sessionAuthProfileId: "xai:p1", sessionAuthProfileSource: "auto" as const }
      : { config: { auth: { order: { xai: ["xai:missing"] } } } }),
  }).toThrow(
    cooldown
      ? expect.objectContaining({ code: AUTH_PROFILE_COOLDOWN_ERROR_CODE })
      : /explicit auth order.*no usable profiles/iu,
  );
});

it("keeps a pinned pending OAuth fence ahead of siblings", () => {
  const prepared = prepare({
    provider: "xai",
    modelId: "grok-4",
    ...userPin("xai:pending"),
    profiles: {
      "xai:pending": createOAuthRefreshFence({
        profileId: "xai:pending",
        credential: oauth({ provider: "xai", access: "expired-access", expires: 1 }),
      }),
      "xai:backup": xaiKey("backup-key"),
    },
    order: { xai: ["xai:backup"] },
  });
  expect(prepared.attempts.filter((a) => a.kind === "profile").map((a) => a.profileId)).toEqual([
    "xai:pending",
    "xai:backup",
  ]);
});

it("defers ambiguous routes to native Codex auth", () => {
  const plan = preparePlan({ ...subscription, ...codexHarness, harnessAuthBootstrap: "harness" });
  expect({
    harnessAuthProvider: plan.harnessAuthProvider,
    modelRoute: plan.modelRoute,
    credentialSource: plan.credentialSource,
    deferredRouteSupport: plan.deferredRouteSupport,
  }).toEqual({
    harnessAuthProvider: "openai",
    modelRoute: undefined,
    credentialSource: undefined,
    deferredRouteSupport: {
      requestTransportOverrides: "none",
      runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
    },
  });
  expect(resolveAgentHarnessPreparedAuthSupport({ plan })).toEqual({ source: "harness" });
});

it("does not hide Platform cooldown behind clear OAuth or literal fallback", () => {
  const store = authStore(pair(), { openai: ["openai:chatgpt", "openai:platform"] });
  setProfileCooldown(store, "openai:platform");
  expectAuthError({
    routeIntent: { authRequirement: "api-key", source: "explicit" },
    config: openAIConfig({ apiKey: "configured-platform-key" }),
    authProfileStore: store,
  }).toThrow(
    expect.objectContaining({
      message: expect.stringContaining("temporarily unavailable"),
      code: AUTH_PROFILE_COOLDOWN_ERROR_CODE,
      profileId: "openai:platform",
    }),
  );
});

it("keeps same-route candidates ahead of interleaved fallbacks", () => {
  const prepared = prepare({
    ...platform,
    ...codexHarness,
    config: {
      secrets: {
        providers: { vault: { source: "file", path: "/tmp/secrets.json", mode: "json" } },
      },
    } as OpenClawConfig,
    profiles: {
      "openai:invalid": {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "vault", id: "OPENAI_API_KEY" },
      },
      "openai:subscription-missing": {
        type: "token",
        provider: "openai",
        tokenRef: { source: "file", provider: "vault", id: "/chatgpt/token" },
      },
      "openai:platform": apiKey(),
      "openai:subscription-backup": token(),
    },
    order: {
      openai: [
        "openai:invalid",
        "openai:subscription-missing",
        "openai:platform",
        "openai:subscription-backup",
      ],
    },
  });
  expect(prepared.plan.forwardedAuthProfileCandidateIds).toEqual([
    "openai:subscription-missing",
    "openai:subscription-backup",
  ]);
  expect(prepared.attempts.map((a) => [a.profileId, a.plan.modelRoute?.authRequirement])).toEqual([
    ["openai:subscription-missing", "subscription"],
    ["openai:subscription-backup", "subscription"],
    ["openai:platform", "api-key"],
  ]);
});

it.each(["profile", "secret-ref"] as const)(
  "prepares and resolves %s Platform auth",
  async (source) => {
    const profile = source === "profile",
      id = "openai:platform-backup";
    if (!profile) {
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("OPENAI_PLATFORM_KEY", "secret-ref-platform-key");
    }
    const config = openAIConfig({
      apiKey: profile
        ? "configured-platform-key"
        : { source: "env", provider: "default", id: "OPENAI_PLATFORM_KEY" },
    });
    const store = authStore(
      profile ? oneProfile(id, apiKey("profile-platform-key")) : {},
      profile ? { openai: [id] } : undefined,
    );
    const { plan, attempts } = prepare({
      ...subscription,
      config,
      authProfileStore: store,
      env: profile ? {} : process.env,
    });
    expect(plan).toMatchObject({
      selectedAuthMode: profile ? "api_key" : "api-key",
      modelRoute: apiRoute,
    });
    if (profile) {
      expect(plan).toMatchObject({
        forwardedAuthProfileId: id,
        forwardedAuthProfileCandidateIds: [id],
      });
      expect(attempts).toEqual([
        { kind: "profile", profileId: id, plan },
        {
          kind: "direct",
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: true,
          plan: expect.objectContaining({
            forwardedAuthProfileId: undefined,
            selectedAuthMode: "api-key",
            modelRoute: expect.objectContaining(apiRoute),
            credentialSource: {
              kind: "direct",
              evidence: "provider-config",
              authorization: "declared",
            },
          }),
        },
      ]);
      expect(attempts.map((a) => a.plan.credentialSource)).toEqual([
        { kind: "profile" },
        { kind: "direct", evidence: "provider-config", authorization: "declared" },
      ]);
    } else {
      expect(attempts).toEqual([
        {
          kind: "direct",
          plan,
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: false,
        },
      ]);
      expect(plan).toMatchObject({
        forwardedAuthProfileId: undefined,
        credentialSource: { kind: "direct", evidence: "environment", authorization: "declared" },
        modelRoute: { baseUrl: "https://api.openai.com/v1" },
      });
      const serialized = JSON.stringify(plan.credentialSource);
      expect(serialized).not.toContain("secret-ref-platform-key");
      expect(serialized).not.toContain("OPENAI_PLATFORM_KEY");
    }
    const resolvedAuth = await getApiKeyForModelCore({
      model: authModel(plan),
      cfg: config,
      store,
      profileId: attempts[0]?.profileId,
      allowAuthProfileFallback: attempts[0]?.allowAuthProfileFallback,
      ...(profile ? { lockedProfile: true } : {}),
    });
    expect(resolvedAuth).toMatchObject({
      apiKey: profile ? "profile-platform-key" : "secret-ref-platform-key",
      source: profile
        ? "profile:openai:platform-backup"
        : "env: OPENAI_PLATFORM_KEY (models.json secretref)",
      mode: "api-key",
    });
    expect(resolvedAuth.profileId).toBe(profile ? id : undefined);
  },
);

it("does not unlock direct fallback when profiles cool down before dispatch", () => {
  const store = authStore(oneProfile("openai:platform", apiKey("profile-platform-key")), {
    openai: ["openai:platform"],
  });
  const [profileAttempt, directAttempt] = prepare({
    config: openAIConfig({ apiKey: "configured-platform-key" }),
    authProfileStore: store,
  }).attempts;
  if (profileAttempt?.kind !== "profile" || directAttempt?.kind !== "direct") {
    throw new Error("expected profile and direct attempts");
  }
  setProfileCooldown(store, "openai:platform");
  expect(
    preparedAgentRuntimeProfileAttemptHasCandidate({
      attempt: profileAttempt,
      store,
      modelId: "gpt-5.5",
    }),
  ).toBe(false);
  expect(
    [false, true].map((priorProfileAttempted) =>
      canRunPreparedAgentRuntimeAuthAttempt({ attempt: directAttempt, priorProfileAttempted }),
    ),
  ).toEqual([false, true]);
});

it("preserves explicit environment endpoints", () => {
  expect(
    preparePlan({
      ...platform,
      env: { OPENAI_API_KEY: "platform-key", OPENAI_BASE_URL: "https://relay.example.test/v1" },
    }).modelRoute,
  ).toEqual({
    provider: "openai",
    modelId: "gpt-5.5",
    ...apiRoute,
    baseUrl: "https://relay.example.test/v1",
    requestTransportOverrides: "none",
    runtimePolicy: { compatibleIds: ["openclaw"] },
  });
});

it("keeps retries behind virtual Codex user pins", () => {
  const prepared = prepare({
    ...nativeCodex,
    ...userPin("openai:p1"),
    profiles: { "openai:p1": token("p1-token"), "openai:p2": apiKey("p2-key") },
    order: { openai: ["openai:p2", "openai:p1"] },
  });
  expect(
    prepared.attempts
      .filter((a) => a.kind === "profile")
      .map((a) => [a.profileId, a.plan.forwardedAuthProfileSource]),
  ).toEqual([
    ["openai:p1", "user"],
    ["openai:p2", "auto"],
  ]);
});

it.each(["incompatible", "missing"] as const)("rejects %s virtual Codex pins", (failure) => {
  const incompatible = failure === "incompatible",
    profileId = incompatible ? "amazon-bedrock:default" : "openai:missing";
  expectAuthError({
    ...nativeCodex,
    ...userPin(profileId),
    config: {
      auth: {
        profiles: {
          [profileId]: incompatible
            ? { provider: "amazon-bedrock", mode: "aws-sdk" }
            : { provider: "openai", mode: "oauth" },
        },
      },
      ...(incompatible
        ? providerConfig("amazon-bedrock", {
            auth: "aws-sdk",
            baseUrl: "https://bedrock.example.test",
          })
        : {}),
    },
  }).toThrow(
    incompatible
      ? /not configured for openai/u
      : expect.objectContaining({
          code: "selected_auth_profile_unavailable",
          reason: "auth",
          status: undefined,
        }),
  );
});

it("does not reuse routed plans for other compaction models", () => {
  const plan = preparePlan({ env: { OPENAI_API_KEY: "platform-key" } });
  expect(
    ["gpt-5.5", "gpt-5.6"].map((modelId) =>
      agentRuntimeAuthPlanMatchesTarget(plan, { provider: "openai", modelId }),
    ),
  ).toEqual([true, false]);
});
