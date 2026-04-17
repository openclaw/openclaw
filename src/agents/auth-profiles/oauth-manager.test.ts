import { describe, expect, it } from "vitest";
import { isSafeToOverwriteStoredOAuthIdentity, OAuthManagerRefreshError } from "./oauth-manager.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function createCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai-codex",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

describe("isSafeToOverwriteStoredOAuthIdentity", () => {
  it("accepts matching account identities", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({ accountId: "acct-123" }),
        createCredential({ access: "rotated-access", accountId: "acct-123" }),
      ),
    ).toBe(true);
  });

  it("refuses overwriting an existing identity-less credential with a different token", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({}),
        createCredential({ access: "rotated-access", accountId: "acct-123" }),
      ),
    ).toBe(false);
  });

  it("refuses non-overlapping identity evidence", () => {
    expect(
      isSafeToOverwriteStoredOAuthIdentity(
        createCredential({ accountId: "acct-123" }),
        createCredential({ access: "rotated-access", email: "user@example.com" }),
      ),
    ).toBe(false);
  });
});

describe("OAuthManagerRefreshError", () => {
  it("serializes without leaking credential or store secrets", () => {
    const refreshedStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:default": createCredential({
          access: "store-access",
          refresh: "store-refresh",
        }),
      },
    };
    const error = new OAuthManagerRefreshError({
      credential: createCredential({ access: "error-access", refresh: "error-refresh" }),
      profileId: "openai-codex:default",
      refreshedStore,
      cause: new Error("boom"),
    });

    const serialized = JSON.stringify(error);
    expect(serialized).toContain("openai-codex");
    expect(serialized).toContain("openai-codex:default");
    expect(serialized).not.toContain("error-access");
    expect(serialized).not.toContain("error-refresh");
    expect(serialized).not.toContain("store-access");
    expect(serialized).not.toContain("store-refresh");
  });
});
