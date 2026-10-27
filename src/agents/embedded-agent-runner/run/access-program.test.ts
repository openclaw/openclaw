import { beforeAll, expect, it, vi } from "vitest";
import { fetchWithSsrFGuard } from "../../../infra/net/fetch-guard.js";
import { withGuardedFetchBeforeRequest } from "../../../infra/net/fetch-request-authority.js";
import type { ProviderPlugin } from "../../../plugins/types.js";
import { loadBundledPluginFacade } from "../../../test-utils/bundled-plugin-public-surface.js";
import type { OAuthCredential } from "../../auth-profiles/types.js";
import type { ModelCatalogSnapshot } from "../../model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "../../prepared-model-runtime-auth.js";
import { createPreparedAccountCatalogAccess } from "../../prepared-model-runtime.catalog-auth.js";
import { prepareEmbeddedAccessProgramGuard } from "./access-program.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

let provider: ProviderPlugin;
beforeAll(async () => {
  const { buildOpenAIProvider } = await loadBundledPluginFacade<{
    buildOpenAIProvider: () => ProviderPlugin;
  }>({ pluginId: "openai", artifactBasename: "api.js" });
  provider = buildOpenAIProvider();
});

const profileId = "openai:default";
const route = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
  requestTransportOverrides: "none",
} as const;
function accessFor(userId = "user-a", accountId = "account-a", nonce = "first") {
  const payload = {
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_user_id: userId,
    },
    nonce,
  };
  return ["fixture", Buffer.from(JSON.stringify(payload)).toString("base64url"), "fixture"].join(
    ".",
  );
}

const discovered: OAuthCredential = {
  type: "oauth",
  provider: "openai",
  access: accessFor(),
  refresh: "refresh-1",
  expires: 1_000,
  accountId: "account-a",
  email: "user@example.test",
};

function attemptWith(credential: OAuthCredential) {
  const snapshot: ModelCatalogSnapshot = {
    entries: [],
    routeVariants: [],
    providerOutcomes: [
      {
        provider: "openai",
        profileId,
        status: "ready",
        modelAccessPrograms: [
          {
            modelId: "synthetic-model",
            runtimeId: "openclaw",
            ...route,
            cyber: ["standard", "daybreak_blue"],
          },
        ],
      },
    ],
  };
  setPreparedModelFullCatalogAuth(snapshot, {
    authStore: { version: 1, profiles: { [profileId]: discovered } },
    authModes: { openai: "oauth" },
    providerAuthLabels: new Map(),
  });
  return {
    provider: "openai",
    modelId: "synthetic-model",
    cyberAccessProgram: "daybreak_blue",
    authProfileId: profileId,
    authProfileStore: { version: 1, profiles: { [profileId]: credential } },
    runtimePlan: { auth: { modelRoute: route, selectedAuthMode: "oauth" } },
    preparedModelRuntime: {
      pluginRegistry: { providers: [{ provider }] },
      accountCatalog: createPreparedAccountCatalogAccess(() => true),
      readFullModelCatalog: () => snapshot,
      isCurrent: () => true,
    },
  } as unknown as EmbeddedRunAttemptParams;
}

it("keeps the discovered program across an OAuth refresh of the same account", async () => {
  await expect(prepareEmbeddedAccessProgramGuard(attemptWith(discovered))).resolves.toBeTypeOf(
    "function",
  );
  const refreshed = {
    ...discovered,
    access: accessFor("user-a", "account-a", "refreshed"),
    refresh: "refresh-2",
    expires: 2_000,
  };
  await expect(prepareEmbeddedAccessProgramGuard(attemptWith(refreshed))).resolves.toBeTypeOf(
    "function",
  );
});

it("never reuses discovered programs for a different account under the same profile", async () => {
  for (const credential of [
    { ...discovered, access: accessFor("user-b"), email: undefined },
    { ...discovered, access: accessFor(""), email: undefined },
    { ...discovered, access: accessFor("user-a", "account-b") },
    { ...discovered, access: "opaque-token" },
    { ...discovered, access: accessFor(), issuer: "https://other.example.test" },
    { ...discovered, access: accessFor(), authFlow: "other-flow" },
  ]) {
    await expect(prepareEmbeddedAccessProgramGuard(attemptWith(credential))).rejects.toMatchObject({
      code: "OPENAI_ACCESS_PROGRAM_UNAVAILABLE",
    });
  }
});

it.each(["current", "revoked", "reassigned"])(
  "checks %s authority at provider dispatch",
  async (state) => {
    const credential = { ...discovered, access: accessFor("user-a", "account-a", "refreshed") };
    const attempt = attemptWith(credential);
    let current = true;
    attempt.preparedModelRuntime = { ...attempt.preparedModelRuntime!, isCurrent: () => current };
    const check = await prepareEmbeddedAccessProgramGuard(attempt);
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const request = withGuardedFetchBeforeRequest(check, () =>
      fetchWithSsrFGuard({
        url: "https://public.example/response",
        lookupFn: async () => {
          if (state === "revoked") {
            current = false;
          }
          if (state === "reassigned") {
            await attempt.preparedModelRuntime!.accountCatalog!.acquire({
              profileId,
              credential: { ...credential, access: accessFor("user-b") },
              allowDiscovery: true,
              load: async () => [],
            });
          }
          return [{ address: "93.184.216.34", family: 4 }];
        },
        fetchImpl,
      }),
    );
    if (state === "current") {
      const result = await request;
      await result.release();
      expect(fetchImpl).toHaveBeenCalledOnce();
    } else {
      await expect(request).rejects.toMatchObject({ code: "OPENAI_ACCESS_PROGRAM_UNAVAILABLE" });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  },
);
