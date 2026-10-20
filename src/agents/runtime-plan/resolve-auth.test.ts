import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { OAuthRefreshFailureError } from "../auth-profiles/oauth-refresh-failure.js";
import { configFor } from "../model-auth.fixtures.test-support.js";
import {
  apiKey,
  authProvider,
  authStore,
  oauth,
  platformModel,
  platformRoute,
  subscriptionModel,
  subscriptionRoute,
  token,
} from "./auth-fixtures.test-support.js";
import type { PreparedAgentRuntimeAuthAttempt } from "./prepare-auth.js";
import {
  resolvePreparedRuntimeAuthAttempts,
  resolvePreparedRuntimeModelAuth,
  scopeAuthProfileStoreToPreparedPlan,
} from "./resolve-auth.js";
import type { AgentRuntimeAuthPlan } from "./types.js";

vi.mock("../model-auth-env-vars.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model-auth-env-vars.js")>()),
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY", "OPENAI_OAUTH_TOKEN"] },
    authEvidenceMap: {},
    setupProviderFallbackRefs: [],
  }),
}));

vi.mock("../../llm/oauth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../llm/oauth.js")>()),
  getOAuthApiKey: vi.fn(async () => {
    throw new Error("invalid_grant");
  }),
}));

function makeProfilePlan(
  profileId: string,
  candidates = [profileId],
  overrides: Partial<AgentRuntimeAuthPlan> = {},
): AgentRuntimeAuthPlan {
  return {
    ...authProvider,
    forwardedAuthProfileId: profileId,
    forwardedAuthProfileSource: "auto",
    forwardedAuthProfileCandidateIds: candidates,
    ...overrides,
  };
}
function profileThenDirect(
  plan: AgentRuntimeAuthPlan,
  directPlan: AgentRuntimeAuthPlan,
): PreparedAgentRuntimeAuthAttempt[] {
  if (!plan.forwardedAuthProfileId) {
    throw new Error("expected a profile plan");
  }
  return [
    { kind: "profile", plan, profileId: plan.forwardedAuthProfileId },
    {
      kind: "direct",
      plan: directPlan,
      allowAuthProfileFallback: false,
      requiresPriorProfileAttempt: true,
    },
  ];
}
type ResolveParams = Parameters<typeof resolvePreparedRuntimeModelAuth>[0];
function resolveModelAuth(
  params: Omit<ResolveParams, "model" | "cfg"> & Partial<Pick<ResolveParams, "model" | "cfg">>,
) {
  return resolvePreparedRuntimeModelAuth({ model: platformModel, cfg: {}, ...params });
}
function expectAuth(params: Parameters<typeof resolveModelAuth>[0]) {
  return expect(resolveModelAuth(params));
}
type AttemptParams = Parameters<typeof resolvePreparedRuntimeAuthAttempts<Model, string>>[0];
function resolveAttempts(
  params: Omit<AttemptParams, "model" | "modelId" | "errorMessage"> &
    Partial<Pick<AttemptParams, "model" | "modelId" | "errorMessage">>,
) {
  return resolvePreparedRuntimeAuthAttempts({
    model: platformModel,
    modelId: "gpt-5.5",
    errorMessage: "prepared auth failed",
    ...params,
  });
}

describe("resolvePreparedRuntimeModelAuth", () => {
  aroundEach((runTest) =>
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "openai", providers: ["openai"] }],
        }),
      },
      runTest,
    ),
  );

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_MISSING_PREPARED_AUTH", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("removes profile and selection state after a Platform key is resolved", () => {
    const store = {
      ...authStore({
        "openai:subscription": token("subscription-token", Date.now() + 60_000),
        "openai:platform": apiKey("platform-key"),
      }),
      order: { openai: ["openai:subscription", "openai:platform"] },
      lastGood: { openai: "openai:subscription" },
      usageStats: { "openai:subscription": { lastUsed: 1 } },
      runtimePersistedProfileIds: ["openai:subscription"],
      runtimeExternalProfileIds: ["openai:subscription"],
      runtimeExternalProfileIdsAuthoritative: true,
    } satisfies AuthProfileStore;

    expect(
      scopeAuthProfileStoreToPreparedPlan(store, {
        ...authProvider,
        forwardedAuthProfileId: "openai:platform",
        forwardedAuthProfileCandidateIds: ["openai:platform"],
        selectedAuthMode: "api-key",
        modelRoute: { ...platformRoute, modelId: "gpt-5.6" },
      }),
    ).toMatchObject({
      profiles: {},
      order: { openai: [] },
      lastGood: {},
      usageStats: {},
      runtimePersistedProfileIds: [],
      runtimeExternalProfileIds: [],
      runtimeExternalProfileIdsAuthoritative: true,
    });
  });

  it("preserves the selected renewable OAuth owner through public Responses preparation", async () => {
    const credential = oauth({
      authFlow: "chatgpt-token-sharing",
      access: "shared-access",
      refresh: "shared-refresh",
      expires: Date.now() + 600_000,
    });
    const store = authStore({
      "openai:shared": credential,
      "openai:unselected": { ...credential, access: "unselected-access" },
    });
    const resolved = await resolveModelAuth({
      plan: {
        ...authProvider,
        forwardedAuthProfileId: "openai:shared",
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: ["openai:shared"],
        selectedAuthMode: "oauth",
        selectedAuthFlow: "chatgpt-token-sharing",
        modelRoute: platformRoute,
      },
      store,
    });
    expect(resolved.auth).toMatchObject({
      apiKey: "shared-access",
      mode: "oauth",
      authFlow: "chatgpt-token-sharing",
      profileId: "openai:shared",
    });
    expect(resolved.plan).toMatchObject({
      selectedAuthMode: "oauth",
      selectedAuthFlow: "chatgpt-token-sharing",
    });
    expect(scopeAuthProfileStoreToPreparedPlan(store, resolved.plan).profiles).toEqual({
      "openai:shared": credential,
    });
  });

  it("keeps a failed explicit SecretRef terminal across prepared profile candidates", async () => {
    const store = authStore({
      "openai:missing": {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_TEST_MISSING_PREPARED_AUTH",
        },
      },
      "openai:backup": apiKey("backup-key"),
    });

    await expectAuth({
      plan: makeProfilePlan("openai:missing", ["openai:missing", "openai:backup"], {
        selectedAuthMode: "api_key",
        modelRoute: platformRoute,
      }),
      store,
      secretSentinels: true,
    }).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "account",
    });
  });

  it(
    "does not borrow an unprepared API-key profile for direct subscription auth",
    { timeout: 1_000 },
    async () => {
      vi.stubEnv("OPENAI_API_KEY", "");
      const store = authStore({
        "openai:platform": apiKey("platform-key"),
      });

      await expectAuth({
        plan: {
          ...authProvider,
          selectedAuthMode: "token",
          modelRoute: subscriptionRoute,
        },
        model: subscriptionModel,
        store,
        secretSentinels: true,
      }).rejects.toThrow('No API key found for provider "openai"');
    },
  );

  it("resolves an ambient Platform key without borrowing the OAuth-only full store", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-platform-key");
    const store = authStore({
      "openai:chatgpt": oauth({ access: "subscription-token", refresh: "refresh-token" }),
    });

    const resolved = await resolveModelAuth({
      plan: {
        ...authProvider,
        selectedAuthMode: "api-key",
        modelRoute: platformRoute,
      },
      store,
      secretSentinels: true,
    });

    expect(resolved).toMatchObject({
      auth: {
        apiKey: "ambient-platform-key",
        mode: "api-key",
      },
      plan: {
        forwardedAuthProfileId: undefined,
        selectedAuthMode: "api-key",
      },
    });
    expect(resolved.auth.source).toContain("OPENAI_API_KEY");
  });

  it.each(["api-key", "oauth"] as const)(
    "keeps authored %s ahead of opposite-route profiles",
    async (mode) => {
      const subscription = mode === "oauth";
      if (subscription) {
        vi.stubEnv("OPENAI_API_KEY", "");
      }
      const model = subscription ? subscriptionModel : platformModel;
      const key = subscription ? "configured-subscription-credential" : "configured-platform-key";
      const store = authStore(
        subscription
          ? { "openai:platform": apiKey("platform-key") }
          : {
              "openai:chatgpt": { type: "token", provider: "openai", token: "subscription-token" },
            },
      );
      const resolved = await resolveModelAuth({
        plan: {
          ...authProvider,
          selectedAuthMode: mode,
          modelRoute: subscription ? subscriptionRoute : platformRoute,
        },
        model,
        cfg: configFor("openai", model.baseUrl, {
          apiKey: key,
          ...(subscription ? { auth: "oauth" } : {}),
        }),
        store,
        secretSentinels: true,
      });
      expect(resolved.auth).toMatchObject({ mode });
      if (subscription) {
        expect(resolved).toMatchObject({
          auth: {
            apiKey: "configured-subscription-credential",
            source: "models.json",
            mode: "oauth",
          },
          plan: { selectedAuthMode: "oauth", modelRoute: { authRequirement: "subscription" } },
        });
      }
    },
  );

  it.each(["changed-class", "expired-oauth"] as const)(
    "resolves a prepared backup after %s",
    async (kind) => {
      const changed = kind === "changed-class";
      const first = changed ? "openai:changed" : "openai:expired";
      const mode = changed ? "token" : "api-key";
      const store = authStore({
        [first]: changed
          ? apiKey("platform-key")
          : oauth({
              access: "expired-access",
              refresh: "expired-refresh",
              expires: Date.now() - 60_000,
            }),
        "openai:backup": changed
          ? token("subscription-token", Date.now() + 60_000)
          : apiKey("backup-key"),
      });
      await expectAuth({
        plan: makeProfilePlan(first, [first, "openai:backup"], {
          selectedAuthMode: changed ? "token" : "api_key",
          modelRoute: changed ? subscriptionRoute : platformRoute,
        }),
        model: changed ? subscriptionModel : platformModel,
        store,
        secretSentinels: true,
      }).resolves.toMatchObject({
        auth: { profileId: "openai:backup", mode },
        plan: {
          forwardedAuthProfileId: "openai:backup",
          forwardedAuthProfileCandidateIds: ["openai:backup"],
          selectedAuthMode: mode,
        },
      });
    },
  );

  it.each([false, true])("rechecks prepared candidates after cooldown (all: %s)", async (all) => {
    const store = authStore({
      "openai:first": apiKey("first-key"),
      "openai:backup": apiKey("backup-key"),
    });
    const plan = makeProfilePlan(
      "openai:first",
      ["openai:first", "openai:backup"],
      all ? {} : { selectedAuthMode: "api_key", modelRoute: platformRoute },
    );
    store.usageStats = Object.fromEntries(
      (all ? ["openai:first", "openai:backup"] : ["openai:first"]).map((id) => [
        id,
        {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit" as const,
          cooldownModel: "gpt-5.5",
        },
      ]),
    );
    const resolution = expectAuth({ plan, store, secretSentinels: true });
    if (all) {
      await resolution.rejects.toThrow("temporarily unavailable");
    } else {
      await resolution.resolves.toMatchObject({
        auth: { profileId: "openai:backup" },
        plan: {
          forwardedAuthProfileId: "openai:backup",
          forwardedAuthProfileCandidateIds: ["openai:backup"],
        },
      });
    }
  });

  it("does not unlock direct fallback when a profile cools during materialization", async () => {
    const store = authStore({
      "openai:first": apiKey("first-key"),
    });
    const profilePlan = makeProfilePlan("openai:first", ["openai:first"]);
    const directPlan = authProvider;
    const resolveAuth = vi.fn(async () => ({ plan: directPlan, auth: "unused" }));
    const materializeModel = vi.fn(async () => {
      store.usageStats = {
        "openai:first": { cooldownUntil: Date.now() + 60_000 },
      };
      return platformModel;
    });

    await expect(
      resolveAttempts({
        attempts: profileThenDirect(profilePlan, directPlan),
        store,
        materializeModel,
        resolveAuth,
      }),
    ).rejects.toThrow("temporarily unavailable");
    expect(materializeModel).toHaveBeenCalledOnce();
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it.each(["secret-ref", "oauth-refresh"] as const)(
    "does not unlock direct fallback after %s failure",
    async (kind) => {
      const secretRef = kind === "secret-ref";
      const profileId = secretRef ? "openai:cold" : "openai:oauth";
      const profilePlan = makeProfilePlan(profileId);
      const directPlan = { ...authProvider, ...(secretRef ? {} : { selectedAuthMode: "api-key" }) };
      const failure = secretRef
        ? new SecretSurfaceUnavailableError({
            ownerKind: "account",
            ownerId: "openai:cold",
            state: "unavailable",
            paths: ["auth-profiles.openai:cold.key"],
            refKeys: ["env:default:MISSING_OPENAI_KEY"],
            reason: "secret reference was not found",
          })
        : new OAuthRefreshFailureError({
            provider: "openai",
            profileId: "openai:oauth",
            message: "OAuth token refresh failed for openai: expired refresh credential",
          });
      const resolveAuth = vi.fn(async ({ attempt }: { attempt: { kind: string } }) => {
        if (attempt.kind === "profile") {
          throw failure;
        }
        return { plan: directPlan, auth: "must-not-be-used" };
      });
      const materializeModel = vi.fn(async () => platformModel);
      await expect(
        resolveAttempts({
          attempts: profileThenDirect(profilePlan, directPlan),
          store: authStore({
            [profileId]: secretRef
              ? apiKey("unused")
              : oauth({
                  access: "expired-access",
                  refresh: "expired-refresh",
                  expires: Date.now() - 60_000,
                }),
          }),
          materializeModel,
          resolveAuth,
        }),
      ).rejects.toBe(failure);
      expect(resolveAuth).toHaveBeenCalledOnce();
      expect(materializeModel).toHaveBeenCalledOnce();
    },
  );

  it("forces unscoped model rematerialization for direct fallback after profile failure", async () => {
    const store = authStore({
      "github-copilot:first": {
        type: "token",
        provider: "github-copilot",
        token: "profile-token",
      },
    });
    const profilePlan = {
      providerForAuth: "github-copilot",
      authProfileProviderForAuth: "github-copilot",
      forwardedAuthProfileId: "github-copilot:first",
      forwardedAuthProfileSource: "auto" as const,
      forwardedAuthProfileCandidateIds: ["github-copilot:first"],
    };
    const directPlan = {
      providerForAuth: "github-copilot",
      authProfileProviderForAuth: "github-copilot",
      selectedAuthMode: "token",
    };
    const profileModel = { ...platformModel, contextWindow: 1_050_000 };
    const directModel = { ...platformModel, contextWindow: 400_000 };
    const materializeModel = vi.fn(async ({ forceResolve }: { forceResolve?: boolean }) =>
      forceResolve ? directModel : profileModel,
    );
    const resolveAuth = vi.fn(
      async ({ attempt }: { attempt: { kind: "direct" | "implicit" | "profile" } }) => {
        if (attempt.kind === "profile") {
          throw new Error("profile credential failed");
        }
        return { plan: directPlan, auth: "direct" };
      },
    );

    const result = await resolveAttempts({
      attempts: profileThenDirect(profilePlan, directPlan),
      store,
      modelId: "gpt-5.6-sol",
      materializeModel,
      resolveAuth,
    });

    expect(result).toMatchObject({ auth: "direct", model: { contextWindow: 400_000 } });
    expect(materializeModel.mock.calls.map(([input]) => input.forceResolve)).toEqual([false, true]);
  });

  it("forces the first direct model when provider metadata is credential-scoped", async () => {
    const directPlan = {
      providerForAuth: "github-copilot",
      authProfileProviderForAuth: "github-copilot",
      selectedAuthMode: "api-key",
    };
    const directModel = { ...platformModel, contextWindow: 1_050_000 };
    const materializeModel = vi.fn(async () => directModel);

    const result = await resolveAttempts({
      attempts: [
        {
          kind: "direct",
          plan: directPlan,
          allowAuthProfileFallback: false,
          requiresPriorProfileAttempt: false,
        },
      ],
      store: authStore({}),
      modelId: "gpt-5.6-sol",
      materializeModel,
      resolveAuth: async () => ({ plan: directPlan, auth: "direct" }),
      forceCredentialScopedDirectModelResolve: true,
    });

    expect(result.model).toBe(directModel);
    expect(materializeModel).toHaveBeenCalledWith({
      plan: directPlan,
      model: platformModel,
      forceResolve: true,
    });
  });

  it("keeps a user-locked profile terminal when environment auth is also present", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-key");
    const store = authStore({
      "openai:locked": apiKey("codex-app-server"),
    });

    await expectAuth({
      plan: {
        ...authProvider,
        forwardedAuthProfileId: "openai:locked",
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: ["openai:locked"],
      },
      store,
      secretSentinels: true,
    }).resolves.toMatchObject({
      auth: { profileId: "openai:locked" },
      plan: {
        forwardedAuthProfileId: "openai:locked",
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: ["openai:locked"],
      },
    });
  });
});
