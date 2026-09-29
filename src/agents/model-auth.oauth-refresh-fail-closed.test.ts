import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createAuthProfileStoreFixture as authStore,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { OAuthRefreshFailureError } from "./auth-profiles/oauth-refresh-failure.js";
import { createOAuthRefreshFence } from "./auth-profiles/oauth-refresh-marker.js";

const authProfileMocks = vi.hoisted(() => ({ resolveApiKeyForProfile: vi.fn() }));
vi.mock("./auth-profiles.js", async (importActual) => ({
  ...(await importActual<typeof import("./auth-profiles.js")>()),
  resolveApiKeyForProfile: authProfileMocks.resolveApiKeyForProfile,
}));
const { resolveApiKeyForProviderCore } = await import("./model-auth.js");
afterEach(() => authProfileMocks.resolveApiKeyForProfile.mockReset());

describe("resolveApiKeyForProviderCore OAuth refresh failure ordering", () => {
  it("does not allow a locked OAuth profile to resolve as another profile", async () => {
    const profileId = "openai:default";
    authProfileMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "alternate-token",
      provider: "openai",
      profileId: "openai:alternate",
    });
    const store = authStore({
      [profileId]: createOAuthRefreshCredential({ expires: 1 }),
      "openai:alternate": createOAuthRefreshCredential({ access: "alternate-token" }),
    });
    await expect(
      resolveApiKeyForProviderCore({
        provider: "openai",
        profileId,
        lockedProfile: true,
        store,
      }),
    ).rejects.toThrow("Locked auth profile resolution returned a different profile");
    expect(authProfileMocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId, allowProfileFallback: false }),
    );
  });

  it("routes a pending fence to the settlement-aware profile resolver", async () => {
    const profileId = "openai:pending-refresh";
    const fence = createOAuthRefreshFence({
      profileId,
      credential: createOAuthRefreshCredential({ expires: 1, accountId: "acct-a" }),
    });
    const store = {
      ...authStore({ [profileId]: fence }),
      order: { openai: [profileId] },
    };
    authProfileMocks.resolveApiKeyForProfile.mockResolvedValueOnce({
      apiKey: "settled-access",
      provider: "openai",
      profileId,
      credential: {
        ...fence,
        access: "settled-access",
        refresh: "settled-refresh",
        expires: Date.now() + 60_000,
      },
    });
    await expect(
      resolveApiKeyForProviderCore({
        provider: "openai",
        cfg: { plugins: { enabled: false } },
        store,
      }),
    ).resolves.toMatchObject({ apiKey: "settled-access", profileId });
    expect(authProfileMocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId }),
    );
  });

  it("does not fall back to env after a configured OAuth profile refresh fails", async () => {
    const profileId = "openai:oauth-refresh";
    const refreshFailure = new OAuthRefreshFailureError({
      provider: "openai",
      profileId,
      message: "OAuth token refresh failed for openai: expired refresh credential",
    });
    authProfileMocks.resolveApiKeyForProfile.mockRejectedValueOnce(refreshFailure);
    await withEnvAsync({ OPENAI_API_KEY: "fallback-must-not-be-used" }, async () => {
      await expect(
        resolveApiKeyForProviderCore({
          provider: "openai",
          cfg: { plugins: { enabled: false }, auth: { order: { openai: [profileId] } } },
          store: authStore({
            [profileId]: createOAuthRefreshCredential({ expires: 1 }),
          }),
        }),
      ).rejects.toBe(refreshFailure);
    });
    expect(authProfileMocks.resolveApiKeyForProfile).toHaveBeenCalledWith(
      expect.objectContaining({ profileId }),
    );
  });
});
