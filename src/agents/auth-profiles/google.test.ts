import { describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "./types.js";

const refreshProviderOAuthCredentialWithPlugin = vi.hoisted(() => vi.fn());
const formatProviderAuthProfileApiKeyWithPlugin = vi.hoisted(() => vi.fn(async () => null));

vi.mock("../../plugins/provider-runtime.runtime.js", () => ({
  refreshProviderOAuthCredentialWithPlugin,
  formatProviderAuthProfileApiKeyWithPlugin,
}));

vi.mock("../../llm/oauth.js", () => ({
  getOAuthProviders: () => [],
  getOAuthApiKey: vi.fn(),
}));

import { resolveGoogleAuthCredential } from "./google.js";

describe("resolveGoogleAuthCredential", () => {
  it("returns typed Google API-key credentials for google profiles", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "google:key-1": {
          type: "api_key",
          provider: "google",
          key: "AIza-test-google-api-key-material",
        },
      },
    };

    await expect(
      resolveGoogleAuthCredential({
        providerId: "google",
        profileId: "google:key-1",
        store,
      }),
    ).resolves.toEqual({
      kind: "api_key",
      providerId: "google",
      profileId: "google:key-1",
      apiKey: "AIza-test-google-api-key-material",
    });
  });

  it("does not resolve API-key profiles for google-gemini-cli", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "google:key-1": {
          type: "api_key",
          provider: "google",
          key: "AIza-test-google-api-key-material",
        },
      },
    };

    await expect(
      resolveGoogleAuthCredential({
        providerId: "google-gemini-cli",
        profileId: "google:key-1",
        store,
      }),
    ).resolves.toBeNull();
  });

  it("returns typed OAuth credentials for google-gemini-cli profiles", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "google-gemini-cli:user@example.test": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "ya29.test-access-token",
          refresh: "1//test-refresh-token",
          expires: Date.now() + 60_000,
          projectId: "project-1",
        },
      },
    };

    await expect(
      resolveGoogleAuthCredential({
        providerId: "google-gemini-cli",
        profileId: "google-gemini-cli:user@example.test",
        store,
      }),
    ).resolves.toEqual({
      kind: "oauth",
      providerId: "google-gemini-cli",
      profileId: "google-gemini-cli:user@example.test",
      accessToken: "ya29.test-access-token",
      refreshToken: "1//test-refresh-token",
      expiresAt: expect.any(Number),
      projectId: "project-1",
    });
  });

  it("does not resolve OAuth profiles for google", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "google-gemini-cli:user@example.test": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "ya29.test-access-token",
          refresh: "1//test-refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };

    await expect(
      resolveGoogleAuthCredential({
        providerId: "google",
        profileId: "google-gemini-cli:user@example.test",
        store,
      }),
    ).resolves.toBeNull();
  });

  it("preserves OAuth refresh errors as causes and does not continue unauthenticated", async () => {
    const original = new Error("refresh failed without token material");
    refreshProviderOAuthCredentialWithPlugin.mockRejectedValueOnce(original);
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "google-gemini-cli:expired@example.test": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "expired-access-token",
          refresh: "expired-refresh-token",
          expires: 1,
        },
      },
    };

    await expect(
      resolveGoogleAuthCredential({
        providerId: "google-gemini-cli",
        profileId: "google-gemini-cli:expired@example.test",
        store,
      }),
    ).rejects.toMatchObject({
      name: "GoogleAuthCredentialResolutionError",
      cause: expect.any(Error),
    });
  });

  it("keeps auth order independent between google and google-gemini-cli", async () => {
    const store: AuthProfileStore = {
      version: 1,
      order: {
        google: ["google:key-2", "google:key-1"],
        "google-gemini-cli": ["google-gemini-cli:user@example.test"],
      },
      profiles: {
        "google:key-1": {
          type: "api_key",
          provider: "google",
          key: "AIza-test-google-api-key-one",
        },
        "google:key-2": {
          type: "api_key",
          provider: "google",
          key: "AIza-test-google-api-key-two",
        },
        "google-gemini-cli:user@example.test": {
          type: "oauth",
          provider: "google-gemini-cli",
          access: "ya29.test-access-token",
          refresh: "1//test-refresh-token",
          expires: Date.now() + 60_000,
        },
      },
    };

    await expect(
      resolveGoogleAuthCredential({
        providerId: "google",
        profileId: store.order?.google?.[0] ?? "",
        store,
      }),
    ).resolves.toMatchObject({
      kind: "api_key",
      profileId: "google:key-2",
      apiKey: "AIza-test-google-api-key-two",
    });
    await expect(
      resolveGoogleAuthCredential({
        providerId: "google-gemini-cli",
        profileId: store.order?.["google-gemini-cli"]?.[0] ?? "",
        store,
      }),
    ).resolves.toMatchObject({
      kind: "oauth",
      profileId: "google-gemini-cli:user@example.test",
    });
  });
});
