import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { createOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import { AUTH_PROFILE_COOLDOWN_ERROR_CODE } from "../failover/error.js";
import { resolveAgentHarnessPreparedAuthSupport } from "../harness/support.js";
import { modelDefinition, providerConfig } from "../model-auth.fixtures.test-support.js";
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

// Provider-hook behavior is covered by its owner suites.
vi.mock("../../plugins/provider-runtime.js", () => ({
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  resolveProviderDeprecatedAuthProfileIds: () => [],
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
  shouldDeferProviderSyntheticProfileAuthWithPlugin: () => undefined,
}));

it("does not defer identity-only ChatGPT login to native Codex credentials", () => {
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

it("prepares token-sharing OAuth on public Responses for Codex", () => {
  const plan = preparePlan({
    ...platform,
    ...codexHarness,
    ...userPin("openai:shared"),
    profiles: oneProfile("openai:shared", oauth({ authFlow: "chatgpt-token-sharing" })),
  });
  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:shared",
    selectedAuthMode: "oauth",
    selectedAuthFlow: "chatgpt-token-sharing",
    modelRoute: {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
    },
  });
});

it("keeps a subscription pin ahead of inherited Platform billing", () => {
  const prepared = prepareAgentRuntimeAuth({
    ...platform,
    ...userPin("openai:chatgpt"),
    config: {
      agents: { defaults: { model: "openai/gpt-5.4@openai:platform" } },
      auth: { profiles: { "openai:platform": { provider: "openai", mode: "api_key" } } },
    },
    authProfileStore: authStore({
      "openai:platform": apiKey("fixture-key"),
      "openai:chatgpt": oauth(),
    }),
  });
  expect(prepared.plan).toMatchObject({
    forwardedAuthProfileId: "openai:chatgpt",
    modelRoute: { authRequirement: "subscription" },
  });
  expect(prepared.attempts.map((attempt) => attempt.profileId)).toEqual(["openai:chatgpt"]);
});

it("keeps a materialized model endpoint on its own credential provider", () => {
  const config: OpenClawConfig = providerConfig("arcee", {
    baseUrl: "https://openrouter.ai/api/v1",
  });
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "arcee",
        providers: ["arcee"],
        providerAuthAliases: {
          arcee: { provider: "openrouter", baseUrls: ["https://openrouter.ai/api/v1"] },
        },
      },
    ],
  });
  const plan = preparePlan({
    provider: "arcee",
    modelId: "trinity-large-thinking",
    modelApi: "openai-completions",
    modelBaseUrl: "https://api.arcee.ai/api/v1",
    config,
    metadataSnapshot,
    profiles: {
      "arcee:direct": createApiKeyCredential("arcee", "direct-model-key"),
      "openrouter:routed": createApiKeyCredential("openrouter", "router-model-key"),
    },
  });

  expect(plan).toMatchObject({
    providerForAuth: "arcee",
    forwardedAuthProfileId: "arcee:direct",
  });
  expect(config.models?.providers?.arcee?.baseUrl).toBe("https://openrouter.ai/api/v1");
});

it("applies provider preference to eligible profiles without locking fallback", () => {
  const plan = preparePlan({
    provider: "xai",
    modelId: "grok-4",
    config: { auth: { profiles: { "xai:invalid": { provider: "xai", mode: "oauth" } } } },
    profiles: {
      "xai:invalid": createApiKeyCredential("xai", "invalid-key"),
      "xai:p1": createApiKeyCredential("xai", "p1-key"),
      "xai:p2": createApiKeyCredential("xai", "p2-key"),
    },
    order: { xai: ["xai:invalid", "xai:p1", "xai:p2"] },
    resolveProviderPreferredProfileId: () => "xai:p2",
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "xai:p2",
    forwardedAuthProfileSource: "auto",
    forwardedAuthProfileCandidateIds: ["xai:p2", "xai:p1"],
  });
});

it.each(["cooldown", "missing"] as const)(
  "fails closed for a generic order with %s profiles",
  (failure) => {
    const cooldown = failure === "cooldown";
    const store = authStore(
      cooldown
        ? {
            "xai:p1": createApiKeyCredential("xai", "p1-key"),
            "xai:p2": createApiKeyCredential("xai", "p2-key"),
          }
        : { "xai:backup": createApiKeyCredential("xai", "backup-key") },
      cooldown ? { xai: ["xai:p1", "xai:p2"] } : undefined,
    );
    if (cooldown) {
      setProfileCooldown(store, "xai:p1", {
        cooldownReason: "rate_limit",
        cooldownModel: "grok-4",
      });
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
  },
);

it("keeps a user-pinned pending OAuth fence ahead of ordered siblings", () => {
  const pendingProfileId = "xai:pending";
  const backupProfileId = "xai:backup";
  const pending = createOAuthRefreshFence({
    profileId: pendingProfileId,
    credential: oauth({
      provider: "xai",
      access: "expired-access",
      expires: 1,
    }),
  });

  const prepared = prepare({
    provider: "xai",
    modelId: "grok-4",
    profiles: {
      [pendingProfileId]: pending,
      [backupProfileId]: createApiKeyCredential("xai", "backup-key"),
    },
    order: { xai: [backupProfileId] },
    ...userPin(pendingProfileId),
  });

  expect(
    prepared.attempts
      .filter((attempt) => attempt.kind === "profile")
      .map((attempt) => attempt.profileId),
  ).toEqual([pendingProfileId, backupProfileId]);
});

it("defers an ambiguous route when native Codex owns auth", () => {
  const plan = preparePlan({
    ...subscription,
    ...codexHarness,
    harnessAuthBootstrap: "harness",
  });

  expect(plan.harnessAuthProvider).toBe("openai");
  expect(plan.modelRoute).toBeUndefined();
  expect(plan.deferredRouteSupport).toEqual({
    requestTransportOverrides: "none",
    runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
  });
  expect(plan.credentialSource).toBeUndefined();
  expect(resolveAgentHarnessPreparedAuthSupport({ plan })).toEqual({ source: "harness" });
});

it("does not let clear OAuth auth hide a cooldown Platform tier before literal fallback", () => {
  const store = authStore(
    {
      "openai:chatgpt": oauth(),
      "openai:platform": apiKey(),
    },
    { openai: ["openai:chatgpt", "openai:platform"] },
  );
  store.usageStats = {
    "openai:platform": { cooldownUntil: Date.now() + 60_000 },
  };

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

it("keeps same-route native candidates ahead of interleaved route fallbacks", () => {
  const preparation = prepare({
    ...platform,
    config: {
      secrets: {
        providers: {
          vault: { source: "file", path: "/tmp/secrets.json", mode: "json" },
        },
      },
    } as OpenClawConfig,
    ...codexHarness,
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

  expect(preparation.plan.forwardedAuthProfileCandidateIds).toEqual([
    "openai:subscription-missing",
    "openai:subscription-backup",
  ]);
  expect(
    preparation.attempts.map((attempt) => ({
      profileId: attempt.profileId,
      authRequirement: attempt.plan.modelRoute?.authRequirement,
    })),
  ).toEqual([
    { profileId: "openai:subscription-missing", authRequirement: "subscription" },
    { profileId: "openai:subscription-backup", authRequirement: "subscription" },
    { profileId: "openai:platform", authRequirement: "api-key" },
  ]);
});

it("does not cross to an incompatible auth route for a user pin", () => {
  expectAuthError({
    ...subscription,
    config: openAIConfig({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    }),
    ...userPin("openai:platform"),
    profiles: oneProfile("openai:platform", apiKey()),
  }).toThrow(/no route-compatible authentication source/iu);
});

it("rejects an official authored route with unvalidated native auth", () => {
  expectAuthError({
    ...platform,
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
    ...codexHarness,
    harnessAuthBootstrap: "harness",
    allowHarnessAuthProfileForwarding: false,
  }).toThrow(/route-compatible authentication source/u);
});

it("rejects a user-locked profile when the harness cannot accept host auth", () => {
  expectAuthError({
    ...platform,
    profiles: oneProfile("openai:work", apiKey()),
    ...userPin("openai:work"),
    ...codexHarness,
    allowHarnessAuthProfileForwarding: false,
  }).toThrow(/native account instead/u);
});

it("honors the no-host-auth policy for non-Codex harnesses", () => {
  const plan = preparePlan({
    provider: "xai",
    modelId: "grok-4",
    config: providerConfig("xai", { auth: "api-key", apiKey: "xai-key" }),
    profiles: {
      "xai:auto": createApiKeyCredential("xai", "profile-key"),
    },
    sessionAuthProfileId: "xai:auto",
    sessionAuthProfileSource: "auto",
    harnessId: "native-remote",
    harnessRuntime: "native-remote",
    allowHarnessAuthProfileForwarding: false,
  });

  expect(plan.forwardedAuthProfileId).toBeUndefined();
  expect(plan.selectedAuthMode).toBeUndefined();
});

it("lets a provider-entry token profile binding outrank configured auth and auth.order", () => {
  const plan = preparePlan({
    ...platform,
    config: openAIConfig({ auth: "api-key", apiKey: "openai:bound" }),
    profiles: {
      "openai:bound": token(undefined, Date.now() + 60_000),
      "openai:platform": apiKey(),
    },
    order: { openai: ["openai:platform", "openai:bound"] },
  });

  expect(plan).toMatchObject({
    forwardedAuthProfileId: "openai:bound",
    forwardedAuthProfileSource: "auto",
    forwardedAuthProfileCandidateIds: ["openai:bound"],
    selectedAuthMode: "token",
    modelRoute: {
      api: "openai-chatgpt-responses",
      authRequirement: "subscription",
    },
  });
});

it.each([
  { provider: "anthropic", mode: "api_key" as const },
  { provider: "openai", mode: "oauth" as const },
])("rejects a bound profile with conflicting $provider/$mode metadata", ({ mode, provider }) => {
  expectAuthError({
    config: {
      auth: { profiles: { "openai:bound": { provider, mode } } },
      ...openAIConfig({ apiKey: "openai:bound" }),
    } as OpenClawConfig,
    profiles: oneProfile("openai:bound", apiKey("bound-platform-key")),
  }).toThrow(/no usable credentials/u);
});

it("rejects an incompatible provider-entry profile without borrowing auth.order", () => {
  expectAuthError({
    ...platform,
    config: openAIConfig({ apiKey: "openai:oauth" }),
    profiles: {
      "openai:oauth": oauth(),
      "openai:platform": apiKey(),
    },
    order: { openai: ["openai:platform"] },
  }).toThrow(/not a compatible bearer profile/u);
});

it("keeps an explicit AWS SDK auth mode ahead of provider-entry profile bindings", () => {
  const plan = preparePlan({
    ...platform,
    config: openAIConfig({ auth: "aws-sdk", apiKey: "openai:bound" }),
    profiles: oneProfile("openai:bound", token(undefined, Date.now() + 60_000)),
  });

  expect(plan.forwardedAuthProfileId).toBeUndefined();
  expect(plan).toMatchObject({
    selectedAuthMode: "aws-sdk",
    modelRoute: apiRoute,
  });
});

it.each(["profile", "secret-ref"] as const)(
  "prepares and resolves %s auth on the Platform route",
  async (source) => {
    const profile = source === "profile";
    const id = "openai:platform-backup";
    if (!profile) {
      vi.stubEnv("OPENAI_API_KEY", "");
      vi.stubEnv("OPENAI_PLATFORM_KEY", "secret-ref-platform-key");
    }
    try {
      const config = openAIConfig({
        apiKey: profile
          ? "configured-platform-key"
          : { source: "env", provider: "default", id: "OPENAI_PLATFORM_KEY" },
      });
      const store = authStore(
        profile ? oneProfile(id, apiKey("profile-platform-key")) : {},
        profile ? { openai: [id] } : undefined,
      );
      const prepared = prepare({
        ...subscription,
        config,
        authProfileStore: store,
        env: profile ? {} : process.env,
      });
      const { plan, attempts } = prepared;
      expect(plan).toMatchObject({
        selectedAuthMode: profile ? "api_key" : "api-key",
        modelRoute: apiRoute,
      });
      if (profile) {
        expect(plan).toMatchObject({
          forwardedAuthProfileId: id,
          forwardedAuthProfileCandidateIds: [id],
        });
        expect({
          kinds: attempts.map((a) => a.kind),
          ids: attempts.map((a) => a.profileId),
          fallback: attempts.map((a) => a.allowAuthProfileFallback),
          prior: attempts.map((a) => a.requiresPriorProfileAttempt),
          forwarded: attempts.map((a) => a.plan.forwardedAuthProfileId),
          sources: attempts.map((a) => a.plan.credentialSource),
        }).toEqual({
          kinds: ["profile", "direct"],
          ids: [id, undefined],
          fallback: [undefined, false],
          prior: [undefined, true],
          forwarded: [id, undefined],
          sources: [
            { kind: "profile" },
            { kind: "direct", evidence: "provider-config", authorization: "declared" },
          ],
        });
        expect(attempts[1]?.plan).toMatchObject({
          selectedAuthMode: "api-key",
          modelRoute: apiRoute,
        });
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
      const resolved = await getApiKeyForModelCore({
        model: authModel(plan),
        cfg: config,
        store,
        profileId: attempts[0]?.profileId,
        allowAuthProfileFallback: attempts[0]?.allowAuthProfileFallback,
        ...(profile ? { lockedProfile: true } : {}),
      });
      expect(resolved).toMatchObject({
        apiKey: profile ? "profile-platform-key" : "secret-ref-platform-key",
        source: profile
          ? "profile:openai:platform-backup"
          : "env: OPENAI_PLATFORM_KEY (models.json secretref)",
        mode: "api-key",
      });
      if (profile) {
        expect(resolved.profileId).toBe(id);
      } else {
        expect(resolved.profileId).toBeUndefined();
      }
    } finally {
      if (!profile) {
        vi.unstubAllEnvs();
      }
    }
  },
);

it("does not unlock direct fallback when every prepared profile cools down before dispatch", () => {
  const store = authStore(oneProfile("openai:platform", apiKey("profile-platform-key")), {
    openai: ["openai:platform"],
  });
  const prepared = prepare({
    config: openAIConfig({ apiKey: "configured-platform-key" }),
    authProfileStore: store,
  });
  const profileAttempt = prepared.attempts[0];
  const directAttempt = prepared.attempts[1];
  if (profileAttempt?.kind !== "profile" || directAttempt?.kind !== "direct") {
    throw new Error("expected profile and direct attempts");
  }
  store.usageStats = {
    "openai:platform": { cooldownUntil: Date.now() + 60_000 },
  };

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

it("reports a local provider marker as synthetic auth", () => {
  const prepared = prepare({
    provider: "ollama-remote",
    modelId: "qwen3.5:27b",
    config: providerConfig("ollama-remote", {
      api: "ollama",
      apiKey: "ollama-local",
      baseUrl: "http://192.168.178.122:11434",
      models: [
        modelDefinition("qwen3.5:27b", {
          name: "Qwen 3.5 27B",
          reasoning: false,
          contextWindow: 8_192,
          maxTokens: 4_096,
        }),
      ],
    }),
  });

  expect(prepared.plan.credentialSource).toEqual({
    kind: "direct",
    evidence: "synthetic",
    authorization: "declared",
  });
});

it("does not queue ambient OAuth behind an incompatible Platform profile", () => {
  expectAuthError({
    config: openAIConfig({ auth: "oauth" }),
    env: { OPENAI_API_KEY: "ambient-oauth-token" },
    profiles: oneProfile("openai:platform", apiKey("profile-platform-key")),
    order: { openai: ["openai:platform"] },
  }).toThrow("Explicit auth order for openai has no usable profiles.");
});

it("rejects configured provider auth that contradicts an authored route", () => {
  expectAuthError({
    ...platform,
    config: openAIConfig({
      auth: "oauth",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
  }).toThrow(/not compatible/u);
});

it("preserves an explicit environment endpoint in the selected route", () => {
  const plan = preparePlan({
    ...platform,
    env: {
      OPENAI_API_KEY: "platform-key",
      OPENAI_BASE_URL: "https://relay.example.test/v1",
    },
  });

  expect(plan.modelRoute).toEqual({
    provider: "openai",
    modelId: "gpt-5.5",
    api: "openai-responses",
    baseUrl: "https://relay.example.test/v1",
    authRequirement: "api-key",
    requestTransportOverrides: "none",
    runtimePolicy: { compatibleIds: ["openclaw"] },
  });
});

it("keeps same-provider retries behind a user-pinned virtual Codex profile", () => {
  const preparation = prepare({
    ...nativeCodex,
    profiles: {
      "openai:p1": token("p1-token"),
      "openai:p2": apiKey("p2-key"),
    },
    order: { openai: ["openai:p2", "openai:p1"] },
    ...userPin("openai:p1"),
  });

  const profileAttempts = preparation.attempts.filter((attempt) => attempt.kind === "profile");
  expect(profileAttempts.map((attempt) => attempt.profileId)).toEqual(["openai:p1", "openai:p2"]);
  expect(profileAttempts.map((attempt) => attempt.plan.forwardedAuthProfileSource)).toEqual([
    "user",
    "auto",
  ]);
});

it.each(["incompatible", "missing"] as const)("rejects a %s virtual Codex user pin", (failure) => {
  const incompatible = failure === "incompatible";
  const profileId = incompatible ? "amazon-bedrock:default" : "openai:missing";
  const profileMetadata = incompatible
    ? { provider: "amazon-bedrock", mode: "aws-sdk" as const }
    : { provider: "openai", mode: "oauth" as const };
  expectAuthError({
    ...nativeCodex,
    ...userPin(profileId),
    config: {
      auth: { profiles: { [profileId]: profileMetadata } },
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

it("does not reuse a routed plan across compaction model overrides", () => {
  const plan = preparePlan({
    env: { OPENAI_API_KEY: "platform-key" },
  });

  expect(
    ["gpt-5.5", "gpt-5.6"].map((modelId) =>
      agentRuntimeAuthPlanMatchesTarget(plan, { provider: "openai", modelId }),
    ),
  ).toEqual([true, false]);
});
