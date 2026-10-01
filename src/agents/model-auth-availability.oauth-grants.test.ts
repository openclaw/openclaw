import { describe, expect, it } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { authStore, evaluate, platformRoute } from "./model-auth-availability.test-support.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";

describe("OAuth inference grants", () => {
  it("selects the API route for a token-sharing grant", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:shared": {
            type: "oauth",
            provider: "openai",
            authFlow: "chatgpt-token-sharing",
            access: "shared-access",
            refresh: "shared-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      }),
    ).toMatchObject({
      availability: true,
      evidence: "profile",
      selectedAuthMode: "oauth",
      selectedProfileId: "openai:shared",
      selectedRoute: platformRoute,
    });
  });

  it("does not advertise inference for an identity-only ChatGPT login", () => {
    expect(
      evaluate({
        store: authStore({
          "openai:identity": {
            type: "oauth",
            provider: "openai",
            authFlow: "chatgpt-identity",
            access: "identity-access",
            refresh: "identity-refresh",
            expires: Date.now() + 60_000,
          },
        }),
      }).availability,
    ).toBe(false);
  });

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
