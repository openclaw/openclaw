import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
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

const { resolveProfile } = vi.hoisted(() => ({ resolveProfile: vi.fn() }));
vi.mock("./auth-profiles/oauth.js", async (importActual) => ({
  ...(await importActual<typeof import("./auth-profiles/oauth.js")>()),
  resolveApiKeyForProfile: resolveProfile,
}));
afterEach(() => resolveProfile.mockReset());
const modelRef = { modelId: "gpt-5.4", runtimeId: "codex" };
const platformCredential = createApiKeyCredential("openai", "platform-key");
async function resolveAuth(
  request: Omit<Parameters<typeof resolveApiKeyForProviderCore>[0], "provider" | "store">,
  authFlow?: "chatgpt-token-sharing",
  withApiKey = true,
  profileId = "openai:oauth",
) {
  await prepareSharedAuthStoreOwnership();
  const store = createAuthProfileStoreFixture({
    [profileId]: createOAuthRefreshCredential({ authFlow, expires: Date.now() + 3_600_000 }),
    ...(withApiKey ? { "openai:platform": platformCredential } : {}),
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

describe("native Codex model auth", () => {
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
    expect(auth.evaluateModelAuth("openai", { modelId: "gpt-5.4" }).availability).not.toBe(true);
    expect(
      auth.evaluateRuntimeModelAuth("openai", { ...modelRef, runtimeId: "openclaw" }).availability,
    ).not.toBe(true);
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
});

describe("OAuth inference grants", () => {
  it.each([
    { authFlow: "chatgpt-token-sharing", profileId: "openai:shared", availability: true },
    { authFlow: "chatgpt-identity", profileId: "openai:identity", availability: false },
  ] as const)(
    "checks inference availability for $authFlow",
    ({ authFlow, profileId, availability }) => {
      const result = evaluate({
        store: authStore({
          [profileId]: createOAuthRefreshCredential({ authFlow }),
        }),
      });
      expect(result).toMatchObject({
        availability,
        ...(availability
          ? {
              evidence: "profile",
              selectedAuthMode: "oauth",
              selectedProfileId: profileId,
              selectedRoute: platformRoute,
            }
          : {}),
      });
    },
  );

  it("does not substitute another account when SIWC is locked for an unsupported capability", async () => {
    await expect(
      resolveAuth(
        {
          capability: "image-generation",
          profileId: "openai:shared",
          lockedProfile: true,
        },
        "chatgpt-token-sharing",
        true,
        "openai:shared",
      ),
    ).rejects.toThrow(/does not support this operation with Sign in with ChatGPT/);
  });
});

describe("OpenAI Decision credentials", () => {
  const decisionRequest = {
    provider: "openai",
    modelId: "gpt-6-luna",
    modelApi: "openai-responses",
    modelBaseUrl: "https://api.openai.com/v1",
    capability: "decision",
  };

  it.each([
    { authFlow: undefined, withApiKey: true },
    { authFlow: "chatgpt-token-sharing" as const, withApiKey: true },
    { authFlow: undefined, withApiKey: false },
    { authFlow: "chatgpt-token-sharing" as const, withApiKey: false },
  ])(
    "excludes OAuth before credential resolution (flow=$authFlow, API key=$withApiKey)",
    async ({ authFlow, withApiKey }) => {
      const order = ["openai:oauth", ...(withApiKey ? ["openai:platform"] : [])];
      resolveProfile.mockImplementation(async ({ profileId }) => {
        if (profileId !== "openai:platform") {
          throw new Error("Incompatible OAuth must not be resolved or refreshed");
        }
        return { apiKey: "platform-key", provider: "openai", profileId };
      });

      await withEnvAsync({ OPENAI_API_KEY: undefined }, async () => {
        const result = resolveAuth(
          {
            ...decisionRequest,
            cfg: { auth: { order: { openai: order } } },
          },
          authFlow,
          withApiKey,
        );
        if (withApiKey) {
          await expect(result).resolves.toMatchObject({
            mode: "api-key",
            apiKey: "platform-key",
            profileId: "openai:platform",
          });
        } else {
          await expect(result).rejects.toMatchObject({
            code: "missing-provider-auth",
            provider: "openai",
          });
        }
      });
      expect(resolveProfile.mock.calls.map(([call]) => call.profileId)).toEqual(
        withApiKey ? ["openai:platform"] : [],
      );
    },
  );

  it("keeps an explicit incompatible OAuth binding terminal despite another API key", async () => {
    await withEnvAsync({ OPENAI_API_KEY: "env-must-not-be-used" }, async () => {
      await expect(
        resolveAuth({
          ...decisionRequest,
          cfg: {
            models: {
              providers: {
                openai: {
                  baseUrl: "https://api.openai.com/v1",
                  api: "openai-responses",
                  apiKey: "openai:oauth",
                  models: [],
                },
              },
            },
          },
        }),
      ).rejects.toThrow(/not a bearer-style auth class/);
    });
    expect(resolveProfile).not.toHaveBeenCalled();
  });
});
