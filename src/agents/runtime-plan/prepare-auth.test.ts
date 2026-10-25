import { expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { createOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../failover/error.js";
import { resolveAgentHarnessPreparedAuthSupport } from "../harness/support.js";
import { providerConfig } from "../model-auth.fixtures.test-support.js";
import * as auth from "./auth-fixtures.test-support.js";
import { prepareAuthFixture } from "./prepare-auth.test-support.js";

const { prepare, preparePlan, expectAuthError } = auth.createPreparationFixture(prepareAuthFixture);
type Params = Parameters<typeof prepare>[0];
const xaiKey = (key: string) => createApiKeyCredential("xai", key);
const pair = () => ({ "openai:platform": auth.apiKey(), "openai:chatgpt": auth.oauth() });
const directSource = (evidence: "synthetic" | "environment" | "provider-config") =>
  ({ kind: "direct", evidence, authorization: "declared" }) as const;
const codexLogin = {
  ...auth.platform,
  ...auth.codexHarness,
  harnessAuthBootstrap: "harness",
} as const;

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
      ...auth.platform,
      ...auth.codexHarness,
      ...auth.userPin("openai:shared"),
      profiles: auth.oneProfile("openai:shared", auth.oauth({ authFlow: "chatgpt-token-sharing" })),
    }),
    {
      forwardedAuthProfileId: "openai:shared",
      selectedAuthMode: "oauth",
      selectedAuthFlow: "chatgpt-token-sharing",
      modelRoute: { ...auth.apiRoute, baseUrl: "https://api.openai.com/v1" },
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
      ...auth.platform,
      config: auth.openAIConfig({ auth: "api-key", apiKey: "openai:bound" }),
      profiles: {
        "openai:bound": auth.token(undefined, Date.now() + 60_000),
        "openai:platform": auth.apiKey(),
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
      ...auth.platform,
      config: auth.openAIConfig({ auth: "aws-sdk", apiKey: "openai:bound" }),
      profiles: auth.oneProfile("openai:bound", auth.token(undefined, Date.now() + 60_000)),
    }),
    { forwardedAuthProfileId: undefined, selectedAuthMode: "aws-sdk", modelRoute: auth.apiRoute },
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
    { credentialSource: directSource("synthetic") },
  ],
] satisfies [string, () => Params, object][])("%s", (_name, fixture, expected) => {
  expect(preparePlan(fixture())).toMatchObject(expected);
});

it("non-Codex harnesses honor no-host-auth policy", () => {
  expect(
    preparePlan({
      provider: "xai",
      modelId: "grok-4",
      config: providerConfig("xai", { auth: "api-key", apiKey: "xai-key" }),
      profiles: { "xai:auto": xaiKey("profile-key") },
      sessionAuthProfileId: "xai:auto",
      sessionAuthProfileSource: "auto",
      harnessId: "native-remote",
      harnessRuntime: "native-remote",
      allowHarnessAuthProfileForwarding: false,
    }),
  ).toMatchObject({ forwardedAuthProfileId: undefined, selectedAuthMode: undefined });
});

it.each([
  [
    "user pins cannot cross incompatible routes",
    () => ({
      ...auth.subscription,
      ...auth.userPin("openai:platform"),
      config: auth.openAIConfig({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      }),
      profiles: auth.oneProfile("openai:platform", auth.apiKey()),
    }),
    /no route-compatible authentication source/iu,
  ],
  [
    "official authored routes reject unvalidated native auth",
    () => ({
      ...codexLogin,
      allowHarnessAuthProfileForwarding: false,
      config: auth.openAIConfig({
        auth: "api-key",
        apiKey: "configured-platform-key",
        baseUrl: "https://api.openai.com/v1",
      }),
      env: { OPENAI_API_KEY: "ambient-platform-key" },
      profiles: auth.oneProfile("openai:chatgpt", auth.oauth()),
      order: { openai: ["openai:chatgpt"] },
      sessionAuthProfileId: "openai:chatgpt",
      sessionAuthProfileSource: "auto",
    }),
    /route-compatible authentication source/u,
  ],
  [
    "locked profile requires a harness accepting host auth",
    () => ({
      ...auth.platform,
      ...auth.codexHarness,
      ...auth.userPin("openai:work"),
      profiles: auth.oneProfile("openai:work", auth.apiKey()),
      allowHarnessAuthProfileForwarding: false,
    }),
    /native account instead/u,
  ],
  [
    "incompatible provider binding cannot borrow ordered auth",
    () => ({
      ...auth.platform,
      config: auth.openAIConfig({ apiKey: "openai:oauth" }),
      profiles: { "openai:oauth": auth.oauth(), "openai:platform": auth.apiKey() },
      order: { openai: ["openai:platform"] },
    }),
    /not a compatible bearer profile/u,
  ],
  [
    "ambient OAuth cannot follow incompatible Platform profiles",
    () => ({
      config: auth.openAIConfig({ auth: "oauth" }),
      env: { OPENAI_API_KEY: "ambient-oauth-token" },
      profiles: auth.oneProfile("openai:platform", auth.apiKey("profile-platform-key")),
      order: { openai: ["openai:platform"] },
    }),
    "Explicit auth order for openai has no usable profiles.",
  ],
  [
    "configured auth cannot contradict authored routes",
    () => ({
      ...auth.platform,
      config: auth.openAIConfig({
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
  expectAuthError({
    ...codexLogin,
    profiles: auth.oneProfile("openai:identity", auth.oauth({ authFlow: "chatgpt-identity" })),
  }).toThrow(/No route-compatible authentication source/);
});

it.each([
  { provider: "anthropic", mode: "api_key" as const },
  { provider: "openai", mode: "oauth" as const },
])("rejects conflicting binding metadata $provider/$mode", ({ mode, provider }) => {
  expectAuthError({
    config: {
      auth: { profiles: { "openai:bound": { provider, mode } } },
      ...auth.openAIConfig({ apiKey: "openai:bound" }),
    },
    profiles: auth.oneProfile("openai:bound", auth.apiKey("bound-platform-key")),
  }).toThrow(/no usable credentials/u);
});

it("keeps subscription pins ahead of inherited Platform billing", () => {
  const prepared = prepare({
    ...auth.platform,
    ...auth.userPin("openai:chatgpt"),
    config: {
      agents: { defaults: { model: "openai/gpt-5.4@openai:platform" } },
      auth: { profiles: { "openai:platform": { provider: "openai", mode: "api_key" } } },
    },
    profiles: pair(),
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
  const store = auth.authStore({ "xai:p1": xaiKey("p1-key") }, { xai: ["xai:p1"] });
  if (cooldown) {
    auth.setProfileCooldown(store, "xai:p1", {
      cooldownReason: "rate_limit",
      cooldownModel: "grok-4",
    });
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
    ...auth.userPin("xai:pending"),
    profiles: {
      "xai:pending": createOAuthRefreshFence({
        profileId: "xai:pending",
        credential: auth.oauth({ provider: "xai", access: "expired-access", expires: 1 }),
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
  const plan = preparePlan({ ...codexLogin, ...auth.subscription });
  expect(plan).toMatchObject({
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
  const store = auth.authStore(pair(), { openai: ["openai:chatgpt", "openai:platform"] });
  auth.setProfileCooldown(store, "openai:platform");
  expectAuthError({
    routeIntent: { authRequirement: "api-key", source: "explicit" },
    config: auth.openAIConfig({ apiKey: "configured-platform-key" }),
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
    ...auth.platform,
    ...auth.codexHarness,
    config: {
      secrets: {
        providers: { vault: { source: "file", path: "/tmp/secrets.json", mode: "json" } },
      },
    },
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
      "openai:platform": auth.apiKey(),
      "openai:subscription-backup": auth.token(),
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

it.each(["profile", "secret-ref"] as const)("prepares %s Platform auth", (source) => {
  const profile = source === "profile",
    id = "openai:platform-backup";
  if (!profile) {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_PLATFORM_KEY", "secret-ref-platform-key");
  }
  const config = auth.openAIConfig({
    apiKey: profile
      ? "configured-platform-key"
      : { source: "env", provider: "default", id: "OPENAI_PLATFORM_KEY" },
  });
  const store = auth.authStore(
    profile ? auth.oneProfile(id, auth.apiKey("profile-platform-key")) : {},
    profile ? { openai: [id] } : undefined,
  );
  const { plan, attempts } = prepare({
    ...auth.subscription,
    config,
    authProfileStore: store,
    env: profile ? {} : process.env,
  });
  expect(plan).toMatchObject({
    forwardedAuthProfileId: profile ? id : undefined,
    selectedAuthMode: profile ? "api_key" : "api-key",
    ...(profile ? { forwardedAuthProfileCandidateIds: [id] } : {}),
  });
  expect(plan.modelRoute).toMatchObject(
    profile ? auth.apiRoute : { ...auth.apiRoute, baseUrl: "https://api.openai.com/v1" },
  );
  expect(
    attempts.map((a) => [
      a.kind,
      a.profileId,
      a.allowAuthProfileFallback,
      a.requiresPriorProfileAttempt,
    ]),
  ).toEqual(
    profile
      ? [
          ["profile", id, undefined, undefined],
          ["direct", undefined, false, true],
        ]
      : [["direct", undefined, false, false]],
  );
  expect(attempts.at(-1)?.plan).toMatchObject({
    forwardedAuthProfileId: undefined,
    selectedAuthMode: "api-key",
    modelRoute: auth.apiRoute,
    credentialSource: directSource(profile ? "provider-config" : "environment"),
  });
  if (!profile) {
    const serialized = JSON.stringify(plan.credentialSource);
    expect(serialized).not.toContain("secret-ref-platform-key");
    expect(serialized).not.toContain("OPENAI_PLATFORM_KEY");
  }
});

it("preserves explicit environment endpoints", () => {
  expect(
    preparePlan({
      ...auth.platform,
      env: { OPENAI_API_KEY: "platform-key", OPENAI_BASE_URL: "https://relay.example.test/v1" },
    }).modelRoute,
  ).toMatchObject({
    ...auth.apiRoute,
    baseUrl: "https://relay.example.test/v1",
  });
});

it("keeps retries behind virtual Codex user pins", () => {
  const prepared = prepare({
    ...auth.nativeCodex,
    ...auth.userPin("openai:p1"),
    profiles: { "openai:p1": auth.token("p1-token"), "openai:p2": auth.apiKey("p2-key") },
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
    ...auth.nativeCodex,
    ...auth.userPin(profileId),
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
