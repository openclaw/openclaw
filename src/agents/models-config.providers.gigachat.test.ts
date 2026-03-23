import { describe, expect, it } from "vitest";
import { GIGACHAT_BASE_URL, GIGACHAT_BASIC_BASE_URL } from "../commands/onboard-auth.models.js";
import { resolveGigachatAuthProfileMetadata } from "./gigachat-auth.js";
import {
  resolveImplicitGigachatBaseUrl,
  resolveStoredProviderAuth,
} from "./models-config.providers.js";

describe("GigaChat implicit provider", () => {
  it("uses the Basic default host for implicit Basic credentials", async () => {
    expect(resolveImplicitGigachatBaseUrl({ apiKey: "user:password" })).toBe(
      GIGACHAT_BASIC_BASE_URL,
    );
  });

  it("keeps the OAuth default host for implicit OAuth credentials keys", async () => {
    expect(resolveImplicitGigachatBaseUrl({ apiKey: "oauth-credentials-key" })).toBe(
      GIGACHAT_BASE_URL,
    );
  });

  it("keeps the OAuth default host for OAuth credentials keys that contain colons", async () => {
    expect(resolveImplicitGigachatBaseUrl({ apiKey: "oauth:credential:with:colon" })).toBe(
      GIGACHAT_BASE_URL,
    );
  });

  it("honors GIGACHAT_BASE_URL for implicit providers", async () => {
    expect(
      resolveImplicitGigachatBaseUrl({
        apiKey: "user:password",
        envBaseUrl: "https://preview.gigachat.example/api/v1",
      }),
    ).toBe("https://preview.gigachat.example/api/v1");
  });

  it("does not inherit stale default-profile metadata for auth-profile-less credentials", async () => {
    const metadata = resolveGigachatAuthProfileMetadata(
      {
        profiles: {
          "gigachat:default": {
            type: "api_key",
            provider: "gigachat",
            metadata: {
              authMode: "basic",
              scope: "GIGACHAT_API_B2B",
            },
          },
        },
      },
      undefined,
      { allowDefaultProfileFallback: false },
    );

    expect(
      resolveImplicitGigachatBaseUrl({
        metadata,
        apiKey: "oauth:credential:with:colon",
      }),
    ).toBe(GIGACHAT_BASE_URL);
  });

  it("honors auth.order when selecting stored GigaChat auth for implicit config", () => {
    const store = {
      version: 1 as const,
      profiles: {
        "gigachat:default": {
          type: "api_key" as const,
          provider: "gigachat",
          key: "oauth-credentials-key",
          metadata: {
            authMode: "oauth",
            scope: "GIGACHAT_API_PERS",
          },
        },
        "gigachat:work": {
          type: "api_key" as const,
          provider: "gigachat",
          key: "basic-user:basic-pass",
          metadata: {
            authMode: "basic",
            scope: "GIGACHAT_API_B2B",
          },
        },
      },
    };
    const auth = resolveStoredProviderAuth({
      cfg: {
        auth: {
          profiles: {
            "gigachat:default": { provider: "gigachat", mode: "api_key" },
            "gigachat:work": { provider: "gigachat", mode: "api_key" },
          },
          order: { gigachat: ["gigachat:work", "gigachat:default"] },
        },
      },
      store,
      provider: "gigachat",
      env: {},
    });
    const metadata = resolveGigachatAuthProfileMetadata(store, auth.profileId);

    expect(auth).toMatchObject({
      apiKey: "basic-user:basic-pass",
      mode: "api_key",
      source: "profile",
      profileId: "gigachat:work",
    });
    expect(
      resolveImplicitGigachatBaseUrl({
        metadata,
        apiKey: auth.discoveryApiKey ?? auth.apiKey,
        authProfileId: auth.profileId,
      }),
    ).toBe(GIGACHAT_BASIC_BASE_URL);
  });
});
