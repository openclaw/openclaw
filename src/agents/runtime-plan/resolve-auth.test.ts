import type { Model } from "openclaw/plugin-sdk/llm";
import { aroundEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { SecretSurfaceUnavailableError } from "../../secrets/runtime-degraded-state.js";
import type { AuthProfileStore } from "../auth-profiles.js";
import { OAuthRefreshFailureError } from "../auth-profiles/oauth-refresh-failure.js";
import { configFor } from "../model-auth.fixtures.test-support.js";
import * as auth from "./auth-fixtures.test-support.js";
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

const directAttempt = (
  plan: AgentRuntimeAuthPlan,
  requiresPriorProfileAttempt = true,
): PreparedAgentRuntimeAuthAttempt => ({
  kind: "direct",
  plan,
  allowAuthProfileFallback: false,
  requiresPriorProfileAttempt,
});
function profileThenDirect(
  plan: AgentRuntimeAuthPlan,
  directPlan: AgentRuntimeAuthPlan = auth.authProvider,
) {
  if (!plan.forwardedAuthProfileId) {
    throw new Error("expected a profile plan");
  }
  return [
    { kind: "profile", plan, profileId: plan.forwardedAuthProfileId },
    directAttempt(directPlan),
  ] satisfies PreparedAgentRuntimeAuthAttempt[];
}
type ResolveParams = Parameters<typeof resolvePreparedRuntimeModelAuth>[0];
function resolveModelAuth(
  params: Omit<ResolveParams, "model" | "cfg"> & Partial<Pick<ResolveParams, "model" | "cfg">>,
) {
  const model = auth.authModel(params.plan);
  return resolvePreparedRuntimeModelAuth({ model, cfg: {}, ...params });
}
function expectAuth(params: Parameters<typeof resolveModelAuth>[0]) {
  return expect(resolveModelAuth({ secretSentinels: true, ...params }));
}
type AttemptParams = Parameters<typeof resolvePreparedRuntimeAuthAttempts<Model, string>>[0];
function resolveAttempts(
  params: Omit<AttemptParams, "model" | "modelId" | "errorMessage" | "materializeModel"> &
    Partial<Pick<AttemptParams, "model" | "modelId" | "errorMessage" | "materializeModel">>,
) {
  return resolvePreparedRuntimeAuthAttempts({
    model: auth.platformModel,
    modelId: "gpt-5.5",
    errorMessage: "prepared auth failed",
    materializeModel: async () => auth.platformModel,
    ...params,
  });
}

const firstId = "openai:first";
const backupId = "openai:backup";
const candidates = [firstId, backupId];
const candidateStore = (
  first: AuthProfileStore["profiles"][string],
  backup: AuthProfileStore["profiles"][string] = auth.apiKey("backup-key"),
) => auth.authStore({ [firstId]: first, [backupId]: backup });
const selectedPlan = (
  subscription: boolean,
  overrides: Partial<AgentRuntimeAuthPlan> = {},
): AgentRuntimeAuthPlan => ({
  ...auth.authProvider,
  selectedAuthMode: subscription ? "token" : "api_key",
  modelRoute: subscription ? auth.subscriptionRoute : auth.platformRoute,
  ...overrides,
});
const candidatePlan = (overrides: Partial<AgentRuntimeAuthPlan> = {}) =>
  auth.profilePlan(firstId, { forwardedAuthProfileCandidateIds: candidates, ...overrides });
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
      ...auth.authStore({
        "openai:subscription": auth.token("subscription-token", Date.now() + 60_000),
        "openai:platform": auth.apiKey("platform-key"),
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
        auth.profilePlan("openai:platform", {
          forwardedAuthProfileSource: undefined,
          selectedAuthMode: "api-key",
          modelRoute: { ...auth.platformRoute, modelId: "gpt-5.6" },
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
    const credential = auth.oauth({ authFlow: "chatgpt-token-sharing", access: "shared-access" });
    const store = auth.authStore({
      [firstId]: credential,
      [backupId]: { ...credential, access: "unselected-access" },
    });
    const resolved = await resolveModelAuth({
      plan: auth.profilePlan(firstId, {
        forwardedAuthProfileSource: "user",
        selectedAuthMode: "oauth",
        selectedAuthFlow: "chatgpt-token-sharing",
        modelRoute: auth.platformRoute,
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
      plan: auth.profilePlan(firstId, { forwardedAuthProfileSource: "user" }),
      store: auth.authStore({ [firstId]: auth.apiKey("codex-app-server") }),
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
    const store = candidateStore({
      type: "api_key",
      provider: "openai",
      keyRef: { source: "env", provider: "default", id: "OPENCLAW_TEST_MISSING_PREPARED_AUTH" },
    });

    await expectAuth({ plan: candidatePlan(selectedPlan(false)), store }).rejects.toMatchObject({
      code: "SECRET_SURFACE_UNAVAILABLE",
      ownerKind: "account",
    });
  });

  it("does not borrow unprepared API-key profiles", { timeout: 1_000 }, async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    await expectAuth({
      plan: { ...auth.authProvider, selectedAuthMode: "token", modelRoute: auth.subscriptionRoute },
      model: auth.subscriptionModel,
      store: auth.authStore({ [firstId]: auth.apiKey() }),
    }).rejects.toThrow('No API key found for provider "openai"');
  });

  it.each([
    ["resolves ambient auth without borrowing OAuth profiles", "api-key", "env"],
    ["keeps authored API keys ahead of OAuth profiles", "api-key", "config"],
    ["keeps authored OAuth ahead of API-key profiles", "oauth", "config"],
  ] as const)("%s", async (_name, mode, source) => {
    const subscription = mode !== "api-key";
    const model = subscription ? auth.subscriptionModel : auth.platformModel;
    const key = "fixture-credential";
    vi.stubEnv("OPENAI_API_KEY", source === "env" ? key : "");
    const result = expectAuth({
      plan: selectedPlan(subscription, { selectedAuthMode: mode }),
      model,
      cfg:
        source === "config"
          ? configFor("openai", model.baseUrl, {
              apiKey: key,
              ...(subscription ? { auth: "oauth" } : {}),
            })
          : {},
      store: auth.authStore({
        [firstId]: subscription ? auth.apiKey() : source === "env" ? auth.oauth() : auth.token(),
      }),
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
      const store = candidateStore(
        changed ? auth.apiKey("platform-key") : auth.oauth({ expires: 1 }),
        changed ? auth.token("subscription-token", Date.now() + 60_000) : auth.apiKey("backup-key"),
      );
      await expectAuth({
        plan: candidatePlan(selectedPlan(changed)),
        model: changed ? auth.subscriptionModel : auth.platformModel,
        store,
      }).resolves.toMatchObject({
        auth: { ...backupResult.auth, mode },
        plan: { ...backupResult.plan, selectedAuthMode: mode },
      });
    },
  );

  it.each([false, true])("rechecks prepared candidates after cooldown (all: %s)", async (all) => {
    const store = candidateStore(auth.apiKey("first-key"));
    const plan = candidatePlan(
      all ? {} : { selectedAuthMode: "api_key", modelRoute: auth.platformRoute },
    );
    auth.setProfileCooldown(store, firstId, {
      cooldownReason: "rate_limit",
      cooldownModel: "gpt-5.5",
    });
    if (all) {
      store.usageStats![backupId] = store.usageStats![firstId];
    }
    const resolution = expectAuth({ plan, store });
    if (all) {
      await resolution.rejects.toThrow("temporarily unavailable");
    } else {
      await resolution.resolves.toMatchObject(backupResult);
    }
  });

  it("does not unlock direct fallback when a profile cools during materialization", async () => {
    const store = auth.authStore({ [firstId]: auth.apiKey("first-key") });
    const resolveAuth = vi.fn(async () => ({ plan: auth.authProvider, auth: "unused" }));
    const materializeModel = vi.fn(async () => {
      auth.setProfileCooldown(store, firstId);
      return auth.platformModel;
    });

    await expect(
      resolveAttempts({
        attempts: profileThenDirect(auth.profilePlan(firstId)),
        store,
        materializeModel,
        resolveAuth,
      }),
    ).rejects.toThrow("temporarily unavailable");
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it.each(["secret-ref", "oauth-refresh"] as const)(
    "does not unlock direct fallback after %s failure",
    async (kind) => {
      const secretRef = kind === "secret-ref";
      const profileId = secretRef ? "openai:cold" : "openai:oauth";
      const preparedProfile = auth.profilePlan(profileId);
      const directPlan = {
        ...auth.authProvider,
        ...(secretRef ? {} : { selectedAuthMode: "api-key" }),
      };
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
      await expect(
        resolveAttempts({
          attempts: profileThenDirect(preparedProfile, directPlan),
          store: auth.authStore({ [profileId]: auth.apiKey("unused") }),
          resolveAuth,
        }),
      ).rejects.toBe(failure);
      expect(resolveAuth).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "forces direct credential-scoped metadata (after profile failure: %s)",
    async (afterProfileFailure) => {
      const provider = {
        providerForAuth: "github-copilot",
        authProfileProviderForAuth: "github-copilot",
      };
      const profilePlan = auth.profilePlan("github-copilot:first", provider);
      const directPlan = {
        ...provider,
        selectedAuthMode: afterProfileFailure ? "token" : "api-key",
      };
      const store = auth.authStore(
        afterProfileFailure
          ? {
              "github-copilot:first": {
                ...auth.token("profile-token"),
                provider: "github-copilot",
              },
            }
          : {},
      );
      const profileModel = { ...auth.platformModel, contextWindow: 1_050_000 };
      const expectedContextWindow = afterProfileFailure ? 400_000 : 1_050_000;
      const directModel = { ...auth.platformModel, contextWindow: expectedContextWindow };
      const result = await resolveAttempts({
        attempts: afterProfileFailure
          ? profileThenDirect(profilePlan, directPlan)
          : [directAttempt(directPlan, false)],
        store,
        modelId: "gpt-5.6-sol",
        materializeModel: async ({ forceResolve }) => (forceResolve ? directModel : profileModel),
        resolveAuth: async ({ attempt }) => {
          if (attempt.kind === "profile") {
            throw new Error("profile credential failed");
          }
          return { plan: directPlan, auth: "direct" };
        },
        forceCredentialScopedDirectModelResolve: !afterProfileFailure,
      });
      expect(result.auth).toBe("direct");
      expect(result.model).toBe(directModel);
    },
  );
});
