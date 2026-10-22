import { afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import * as providerRuntime from "../plugins/provider-runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture as authStore,
  createOAuthRefreshCredential as oauth,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import { createOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./auth-profiles/path-resolve.native.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

const { resolveProfile } = vi.hoisted(() => ({ resolveProfile: vi.fn() }));
vi.mock("./auth-profiles.js", async (importActual) => ({
  ...(await importActual<typeof import("./auth-profiles.js")>()),
  resolveApiKeyForProfile: resolveProfile,
}));
const { resolveApiKeyForProviderCore: resolveAuth } = await import("./model-auth.js");
beforeAll(() => {
  prepareSharedAuthStoreOwnershipForNative();
});
afterEach(() => resolveProfile.mockReset());
function expectProfile(profileId: string, options = {}) {
  expect(resolveProfile).toHaveBeenCalledWith(expect.objectContaining({ profileId, ...options }));
}

it.each([
  { provider: "custom-auth", fallback: "synthetic" },
  { provider: "openai", fallback: "env" },
])(
  "does not restore $fallback auth after OAuth refresh failure",
  async ({ provider, fallback }) => {
    const profileId = `${provider}:oauth-refresh`;
    const syntheticId = `${provider}:synthetic`;
    const failure = new OAuthRefreshFailureError({ provider, profileId, message: "expired" });
    const profiles: AuthProfileStore["profiles"] = { [profileId]: oauth({ provider, expires: 1 }) };
    if (fallback === "synthetic") {
      profiles[syntheticId] = createApiKeyCredential(provider, "synthetic-defer");
      const defer = vi
        .spyOn(providerRuntime, "shouldDeferProviderSyntheticProfileAuthWithPlugin")
        .mockImplementation(({ context }) => context.resolvedApiKey === "synthetic-defer");
      onTestFinished(() => defer.mockRestore());
      resolveProfile.mockImplementation(async ({ profileId: requested }) => {
        if (requested === syntheticId) {
          return { apiKey: "synthetic-defer", provider, profileId: syntheticId };
        }
        throw failure;
      });
    } else {
      resolveProfile.mockRejectedValueOnce(failure);
    }
    const request = {
      provider,
      profileId: fallback === "synthetic" ? syntheticId : undefined,
      cfg: { plugins: { enabled: false }, auth: { order: { [provider]: [profileId] } } },
      store: authStore(profiles),
    };
    await withEnvAsync(
      fallback === "env" ? { OPENAI_API_KEY: "fallback-must-not-be-used" } : {},
      async () => {
        await expect(resolveAuth(request)).rejects.toBe(failure);
      },
    );
    expectProfile(profileId);
  },
);

it("does not allow a locked OAuth profile to resolve as another profile", async () => {
  const profileId = "openai:default";
  const alt = { apiKey: "alternate-token", provider: "openai", profileId: "openai:alternate" };
  resolveProfile.mockResolvedValueOnce(alt);
  await expect(
    resolveAuth({
      provider: "openai",
      profileId,
      lockedProfile: true,
      store: authStore({
        [profileId]: oauth({ expires: 1 }),
        "openai:alternate": oauth({ access: "alternate-token" }),
      }),
    }),
  ).rejects.toThrow("Locked auth profile resolution returned a different profile");
  expectProfile(profileId, { allowProfileFallback: false });
});

it("routes a pending fence to the settlement-aware profile resolver", async () => {
  const profileId = "openai:pending-refresh";
  const expired = oauth({ expires: 1, accountId: "acct-a" });
  const fence = createOAuthRefreshFence({ profileId, credential: expired });
  const credential = {
    ...fence,
    access: "settled-access",
    refresh: "settled-refresh",
    expires: Date.now() + 60_000,
  };
  const settled = { apiKey: "settled-access", provider: "openai", profileId, credential };
  resolveProfile.mockResolvedValueOnce(settled);
  await expect(
    resolveAuth({
      provider: "openai",
      cfg: { plugins: { enabled: false } },
      store: { ...authStore({ [profileId]: fence }), order: { openai: [profileId] } },
    }),
  ).resolves.toMatchObject({ apiKey: "settled-access", profileId });
  expectProfile(profileId);
});
