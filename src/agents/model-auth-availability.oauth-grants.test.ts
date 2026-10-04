import { describe, expect, it } from "vitest";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
  createOAuthRefreshCredential,
} from "./auth-profiles/credential-fixtures.test-support.js";
import { authStore, evaluate, platformRoute } from "./model-auth-availability.test-support.js";
import { resolveApiKeyForProviderCore } from "./model-auth-provider.js";

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
