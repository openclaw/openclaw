import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createApiKeyCredential as apiKey,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnership } from "./auth-profiles/path-resolve.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  evaluate,
  dualRoutes,
  platformRoute,
  subscriptionRoute,
  routeResolverFactory,
  mockRouteResolverFactory,
} from "./model-auth-availability.test-support.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";
import { providerConfig } from "./model-auth.fixtures.test-support.js";

const { resolveProfile } = vi.hoisted(() => ({ resolveProfile: vi.fn() }));
vi.mock("./auth-profiles/oauth.js", async (importActual) => ({
  ...(await importActual<typeof import("./auth-profiles/oauth.js")>()),
  resolveApiKeyForProfile: resolveProfile,
}));
afterEach(() => resolveProfile.mockReset());
const modelRef = { modelId: "gpt-5.4", runtimeId: "codex" };
async function resolveAuth(
  request: Omit<Parameters<typeof resolveApiKeyForProviderCore>[0], "provider" | "store">,
  authFlow?: "chatgpt-token-sharing",
  withApiKey = true,
) {
  await prepareSharedAuthStoreOwnership();
  const credential = createOAuthRefreshCredential({ authFlow, expires: Date.now() + 3_600_000 });
  const store = authStore({
    [request.profileId ?? "openai:oauth"]: credential,
    ...(withApiKey ? { "openai:platform": apiKey("openai", "platform-key") } : {}),
  });
  return resolveApiKeyForProviderCore({ provider: "openai", store, ...request });
}

function resolver(mode?: "api_key" | "oauth" | "token", cfg: OpenClawConfig = {}, complete = true) {
  mockRouteResolverFactory(routeResolverFactory(dualRoutes));
  return createModelAuthAvailabilityResolver({
    cfg,
    env: {},
    authStore: { version: 1, profiles: {} },
    syntheticAuthProviderRefs: ["codex"],
    preparedRuntimeAuthModes: mode ? { codex: { source: "native", mode } } : {},
    preparedSyntheticAuthComplete: complete,
  });
}

it.each([
  ["api_key", platformRoute],
  ["oauth", subscriptionRoute],
] as const)("selects the route for native %s auth without a host profile", (mode, route) => {
  const auth = resolver(mode);
  expect(auth.evaluateRuntimeModelAuth("openai", modelRef)).toMatchObject({
    availability: true,
    selectedRoute: route,
    runtimeAuth: { id: "codex", source: "native" },
  });
  expect([
    auth.evaluateModelAuth("openai", { modelId: "gpt-5.4" }).availability,
    auth.evaluateRuntimeModelAuth("openai", { ...modelRef, runtimeId: "openclaw" }).availability,
  ]).not.toContain(true);
});

it("distinguishes a completed logout from an unobserved native account", () => {
  expect(resolver().evaluateRuntimeModelAuth("openai", modelRef).availability).toBe(false);
  expect(
    resolver(undefined, {}, false).evaluateRuntimeModelAuth("openai", modelRef).availability,
  ).toBeUndefined();
});

it.each([
  { boundary: "pinned account", cfg: {}, ref: { pinnedProfileId: "openai:missing" } },
  { boundary: "empty account order", cfg: { auth: { order: { openai: [] } } }, ref: {} },
])("keeps $boundary authoritative over native login", ({ cfg, ref }) => {
  expect(
    resolver("api_key", cfg).evaluateRuntimeModelAuth("openai", { ...modelRef, ...ref })
      .availability,
  ).not.toBe(true);
});
it.each([
  ["chatgpt-token-sharing", "openai:shared", true],
  ["chatgpt-identity", "openai:identity", false],
] as const)("inference grant for %s", (authFlow, profileId, availability) => {
  const credential = createOAuthRefreshCredential({ authFlow });
  const result = evaluate({ store: authStore({ [profileId]: credential }) });
  expect(result).toMatchObject({ availability });
  if (availability) {
    expect(result).toMatchObject({
      evidence: "profile",
      selectedAuthMode: "oauth",
      selectedProfileId: profileId,
      selectedRoute: platformRoute,
    });
  }
});

it("does not substitute another account when SIWC is locked for an unsupported capability", async () => {
  await expect(
    resolveAuth(
      {
        capability: "image-generation",
        profileId: "openai:shared",
        lockedProfile: true,
      },
      "chatgpt-token-sharing",
    ),
  ).rejects.toThrow(/does not support this operation with Sign in with ChatGPT/);
});
const decisionRequest = {
  modelId: "gpt-6-luna",
  modelApi: "openai-responses",
  modelBaseUrl: "https://api.openai.com/v1",
  capability: "decision",
};

it.each([
  [undefined, true],
  ["chatgpt-token-sharing", true],
  [undefined, false],
  ["chatgpt-token-sharing", false],
] as const)("filters Decision OAuth (flow=%s, API key=%s)", async (authFlow, withApiKey) => {
  const order = ["openai:oauth", ...(withApiKey ? ["openai:platform"] : [])];
  resolveProfile.mockImplementation(async ({ profileId }) => {
    if (profileId !== "openai:platform") {
      throw new Error("Incompatible OAuth must not be resolved or refreshed");
    }
    return { apiKey: "platform-key", provider: "openai", profileId };
  });

  const request = { ...decisionRequest, cfg: { auth: { order: { openai: order } } } };
  await withEnvAsync({ OPENAI_API_KEY: undefined }, async () => {
    const result = resolveAuth(request, authFlow, withApiKey);
    await expect(result)[withApiKey ? "resolves" : "rejects"].toMatchObject(
      withApiKey
        ? { mode: "api-key", apiKey: "platform-key", profileId: "openai:platform" }
        : { code: "missing-provider-auth", provider: "openai" },
    );
  });
  expect(resolveProfile.mock.calls.map(([call]) => call.profileId)).toEqual(
    withApiKey ? ["openai:platform"] : [],
  );
});

it("keeps an explicit incompatible OAuth binding terminal despite another API key", async () => {
  await withEnvAsync({ OPENAI_API_KEY: "env-must-not-be-used" }, async () => {
    await expect(
      resolveAuth({
        ...decisionRequest,
        cfg: providerConfig("openai", {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-responses",
          apiKey: "openai:oauth",
        }),
      }),
    ).rejects.toThrow(/not a bearer-style auth class/);
  });
  expect(resolveProfile).not.toHaveBeenCalled();
});
