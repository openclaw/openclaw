import type { Model } from "openclaw/plugin-sdk/llm";
import { aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  profilePlan as makeProfilePlan,
  setProfileCooldown,
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

function profileThenDirect(
  plan: AgentRuntimeAuthPlan,
  directPlan: AgentRuntimeAuthPlan = authProvider,
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
  params: Omit<AttemptParams, "model" | "modelId" | "errorMessage" | "materializeModel"> &
    Partial<Pick<AttemptParams, "model" | "modelId" | "errorMessage" | "materializeModel">>,
) {
  return resolvePreparedRuntimeAuthAttempts({
    model: platformModel,
    modelId: "gpt-5.5",
    errorMessage: "prepared auth failed",
    materializeModel: async () => platformModel,
    ...params,
  });
}

const firstId = "openai:first";
const backupId = "openai:backup";
const candidates = [firstId, backupId];
const candidatePlan = (overrides: Partial<AgentRuntimeAuthPlan> = {}) =>
  makeProfilePlan(firstId, { forwardedAuthProfileCandidateIds: candidates, ...overrides });
const backupResult = {
  auth: { profileId: backupId },
  plan: { forwardedAuthProfileId: backupId, forwardedAuthProfileCandidateIds: [backupId] },
};

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
      scopeAuthProfileStoreToPreparedPlan(
        store,
        makeProfilePlan("openai:platform", {
          forwardedAuthProfileSource: undefined,
          selectedAuthMode: "api-key",
          modelRoute: { ...platformRoute, modelId: "gpt-5.6" },
        }),
      ),
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
      [firstId]: credential,
      [backupId]: { ...credential, access: "unselected-access" },
    });
    const resolved = await resolveModelAuth({
      plan: makeProfilePlan(firstId, {
        forwardedAuthProfileSource: "user",
        selectedAuthMode: "oauth",
        selectedAuthFlow: "chatgpt-token-sharing",
        modelRoute: platformRoute,
      }),
      store,
    });
    expect(resolved).toMatchObject({
      auth: {
        apiKey: "shared-access",
        mode: "oauth",
        authFlow: "chatgpt-token-sharing",
        profileId: firstId,
      },
      plan: {
        selectedAuthMode: "oauth",
        selectedAuthFlow: "chatgpt-token-sharing",
        forwardedAuthProfileId: firstId,
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: [firstId],
      },
    });
    expect(scopeAuthProfileStoreToPreparedPlan(store, resolved.plan).profiles).toEqual({
      [firstId]: credential,
    });
  });

  it("keeps a user-locked synthetic profile terminal despite ambient auth", async () => {
    vi.stubEnv("OPENAI_API_KEY", "ambient-key");
    await expectAuth({
      plan: makeProfilePlan(firstId, { forwardedAuthProfileSource: "user" }),
      store: authStore({ [firstId]: apiKey("codex-app-server") }),
      secretSentinels: true,
    }).resolves.toMatchObject({
      auth: { profileId: firstId },
      plan: {
        forwardedAuthProfileId: firstId,
        forwardedAuthProfileSource: "user",
        forwardedAuthProfileCandidateIds: [firstId],
      },
    });
  });

  it("keeps a failed explicit SecretRef terminal across prepared profile candidates", async () => {
    const store = authStore({
      [firstId]: {
        type: "api_key",
        provider: "openai",
        keyRef: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_TEST_MISSING_PREPARED_AUTH",
        },
      },
      [backupId]: apiKey("backup-key"),
    });

    await expectAuth({
      plan: candidatePlan({
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

  it("does not borrow unprepared API-key profiles", { timeout: 1_000 }, async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expectAuth({
      plan: { ...authProvider, selectedAuthMode: "token", modelRoute: subscriptionRoute },
      model: subscriptionModel,
      store: authStore({ [firstId]: apiKey() }),
      secretSentinels: true,
    }).rejects.toThrow('No API key found for provider "openai"');
  });

  it.each([
    ["resolves ambient auth without borrowing OAuth profiles", "api-key", "env"],
    ["keeps authored API keys ahead of OAuth profiles", "api-key", "config"],
    ["keeps authored OAuth ahead of API-key profiles", "oauth", "config"],
  ] as const)("%s", async (_name, mode, source) => {
    const subscription = mode !== "api-key";
    const model = subscription ? subscriptionModel : platformModel;
    const key =
      source === "env"
        ? "ambient-platform-key"
        : subscription
          ? "configured-subscription-credential"
          : "configured-platform-key";
    vi.stubEnv("OPENAI_API_KEY", source === "env" ? key : "");
    const result = expectAuth({
      plan: {
        ...authProvider,
        selectedAuthMode: mode,
        modelRoute: subscription ? subscriptionRoute : platformRoute,
      },
      model,
      cfg:
        source === "config"
          ? configFor("openai", model.baseUrl, {
              apiKey: key,
              ...(subscription ? { auth: "oauth" } : {}),
            })
          : {},
      store: authStore({
        [firstId]: subscription
          ? apiKey()
          : source === "env"
            ? oauth({ access: "subscription-token", refresh: "refresh-token" })
            : token(),
      }),
      secretSentinels: true,
    });
    await result.resolves.toMatchObject({
      auth: {
        apiKey: key,
        mode,
        source: source === "config" ? "models.json" : expect.stringContaining("OPENAI_API_KEY"),
      },
      plan: {
        forwardedAuthProfileId: undefined,
        selectedAuthMode: mode,
        modelRoute: { authRequirement: subscription ? "subscription" : "api-key" },
      },
    });
  });

  it.each(["changed-class", "expired-oauth"] as const)(
    "resolves a prepared backup after %s",
    async (kind) => {
      const changed = kind === "changed-class";
      const mode = changed ? "token" : "api-key";
      const store = authStore({
        [firstId]: changed
          ? apiKey("platform-key")
          : oauth({
              access: "expired-access",
              refresh: "expired-refresh",
              expires: Date.now() - 60_000,
            }),
        [backupId]: changed
          ? token("subscription-token", Date.now() + 60_000)
          : apiKey("backup-key"),
      });
      await expectAuth({
        plan: candidatePlan({
          selectedAuthMode: changed ? "token" : "api_key",
          modelRoute: changed ? subscriptionRoute : platformRoute,
        }),
        model: changed ? subscriptionModel : platformModel,
        store,
        secretSentinels: true,
      }).resolves.toMatchObject({
        auth: { ...backupResult.auth, mode },
        plan: { ...backupResult.plan, selectedAuthMode: mode },
      });
    },
  );

  it.each([false, true])("rechecks prepared candidates after cooldown (all: %s)", async (all) => {
    const store = authStore({
      [firstId]: apiKey("first-key"),
      [backupId]: apiKey("backup-key"),
    });
    const plan = candidatePlan(
      all ? {} : { selectedAuthMode: "api_key", modelRoute: platformRoute },
    );
    store.usageStats = Object.fromEntries(
      (all ? candidates : [firstId]).map((id) => [
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
      await resolution.resolves.toMatchObject(backupResult);
    }
  });

  it("does not unlock direct fallback when a profile cools during materialization", async () => {
    const store = authStore({ [firstId]: apiKey("first-key") });
    const resolveAuth = vi.fn(async () => ({ plan: authProvider, auth: "unused" }));
    const materializeModel = vi.fn(async () => {
      setProfileCooldown(store, firstId);
      return platformModel;
    });

    await expect(
      resolveAttempts({
        attempts: profileThenDirect(makeProfilePlan(firstId)),
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
      const preparedProfile = makeProfilePlan(profileId);
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
          attempts: profileThenDirect(preparedProfile, directPlan),
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

  it.each([true, false])(
    "forces direct credential-scoped metadata (after profile failure: %s)",
    async (afterProfileFailure) => {
      const provider = {
        providerForAuth: "github-copilot",
        authProfileProviderForAuth: "github-copilot",
      };
      const profilePlan = makeProfilePlan("github-copilot:first", provider);
      const directPlan = {
        ...provider,
        selectedAuthMode: afterProfileFailure ? "token" : "api-key",
      };
      const store = authStore(
        afterProfileFailure
          ? {
              "github-copilot:first": {
                type: "token",
                provider: "github-copilot",
                token: "profile-token",
              },
            }
          : {},
      );
      const profileModel = { ...platformModel, contextWindow: 1_050_000 };
      const expectedContextWindow = afterProfileFailure ? 400_000 : 1_050_000;
      const directModel = {
        ...platformModel,
        contextWindow: expectedContextWindow,
      };
      const materializeModel = vi.fn(async ({ forceResolve }: { forceResolve?: boolean }) =>
        forceResolve ? directModel : profileModel,
      );
      const result = await resolveAttempts({
        attempts: afterProfileFailure
          ? profileThenDirect(profilePlan, directPlan)
          : [
              {
                kind: "direct",
                plan: directPlan,
                allowAuthProfileFallback: false,
                requiresPriorProfileAttempt: false,
              },
            ],
        store,
        modelId: "gpt-5.6-sol",
        materializeModel,
        resolveAuth: async ({ attempt }) => {
          if (attempt.kind === "profile") {
            throw new Error("profile credential failed");
          }
          return { plan: directPlan, auth: "direct" };
        },
        forceCredentialScopedDirectModelResolve: !afterProfileFailure,
      });
      expect(result).toMatchObject({
        auth: "direct",
        model: { contextWindow: expectedContextWindow },
      });
      expect(result.model).toBe(directModel);
      expect(materializeModel.mock.calls).toEqual([
        ...(afterProfileFailure
          ? [[{ plan: profilePlan, model: platformModel, forceResolve: false }]]
          : []),
        [{ plan: directPlan, model: platformModel, forceResolve: true }],
      ]);
    },
  );
});
