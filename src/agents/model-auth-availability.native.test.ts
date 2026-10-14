import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import {
  authStore,
  evaluate,
  dualRoutes,
  platformRoute,
  subscriptionRoute,
  routeResolverFactory,
} from "./model-auth-availability.test-support.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";

function resolver(mode?: "api_key" | "oauth" | "token", cfg: OpenClawConfig = {}, complete = true) {
  return createModelAuthAvailabilityResolver({
    cfg,
    env: {},
    authStore: { version: 1, profiles: {} },
    syntheticAuthProviderRefs: ["codex"],
    preparedRuntimeAuthModes: mode ? { codex: { source: "native", mode } } : {},
    preparedSyntheticAuthComplete: complete,
    routeResolverFactory: routeResolverFactory(dualRoutes),
  });
}

describe("native Codex model auth", () => {
  it.each([
    ["api_key", platformRoute],
    ["oauth", subscriptionRoute],
  ] as const)("selects the route for native %s auth without a host profile", (mode, route) => {
    const auth = resolver(mode);
    expect(
      auth.evaluateRuntimeModelAuth("openai", { modelId: "gpt-5.4", runtimeId: "codex" }),
    ).toMatchObject({
      availability: true,
      selectedRoute: route,
      runtimeAuth: { id: "codex", source: "native" },
    });
    expect(auth.evaluateModelAuth("openai", { modelId: "gpt-5.4" }).availability).not.toBe(true);
    expect(
      auth.evaluateRuntimeModelAuth("openai", { modelId: "gpt-5.4", runtimeId: "openclaw" })
        .availability,
    ).not.toBe(true);
  });

  it("distinguishes a completed logout from an unobserved native account", () => {
    const ref = { modelId: "gpt-5.4", runtimeId: "codex" };
    expect(resolver().evaluateRuntimeModelAuth("openai", ref).availability).toBe(false);
    expect(
      resolver(undefined, {}, false).evaluateRuntimeModelAuth("openai", ref).availability,
    ).toBeUndefined();
  });

  it("does not rescue a pinned account with the native login", () => {
    expect(
      resolver("api_key").evaluateRuntimeModelAuth("openai", {
        modelId: "gpt-5.4",
        runtimeId: "codex",
        pinnedProfileId: "openai:missing",
      }).availability,
    ).not.toBe(true);
  });

  it("keeps an authored empty account order authoritative", () => {
    expect(
      resolver("api_key", { auth: { order: { openai: [] } } }).evaluateRuntimeModelAuth("openai", {
        modelId: "gpt-5.4",
        runtimeId: "codex",
      }).availability,
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
      expect(result.availability).toBe(availability);
      if (availability) {
        expect(result).toMatchObject({
          evidence: "profile",
          selectedAuthMode: "oauth",
          selectedProfileId: profileId,
          selectedRoute: platformRoute,
        });
      }
    },
  );

  it("does not substitute another account when SIWC is locked for an unsupported capability", async () => {
    await expect(
      resolveApiKeyForProviderCore({
        provider: "openai",
        capability: "image-generation",
        profileId: "openai:shared",
        lockedProfile: true,
        store: createAuthProfileStoreFixture({
          "openai:shared": createOAuthRefreshCredential({
            authFlow: "chatgpt-token-sharing",
            expires: Date.now() + 3_600_000,
          }),
          "openai:platform": createApiKeyCredential("openai", "platform-key"),
        }),
      }),
    ).rejects.toThrow(/does not support this operation with Sign in with ChatGPT/);
  });
});
