import { describe, expect, it } from "vitest";
import {
  findFreshOAuthCredentialForCoordinationKey,
  resolveOAuthRefreshCoordinationKey,
} from "./oauth-refresh-coordination.js";
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

describe("resolveOAuthRefreshCoordinationKey", () => {
  it("uses account id before profile id so same-account Codex profiles share one lock", () => {
    expect(
      resolveOAuthRefreshCoordinationKey({
        provider: "openai-codex",
        profileId: "openai-codex:default",
        credential: createCredential({ accountId: "acct-123", email: "Admin@DolbodaHealth.com" }),
      }),
    ).toEqual({ kind: "account", value: "openai-codex\u0000account\u0000acct-123" });
  });

  it("normalizes email when account id is absent", () => {
    expect(
      resolveOAuthRefreshCoordinationKey({
        provider: "openai-codex",
        profileId: "openai-codex:admin@dolbodahealth.com",
        credential: createCredential({ email: " Admin@DolbodaHealth.com " }),
      }),
    ).toEqual({
      kind: "email",
      value: "openai-codex\u0000email\u0000admin@dolbodahealth.com",
    });
  });

  it("falls back to a non-secret refresh fingerprint before profile id", () => {
    const key = resolveOAuthRefreshCoordinationKey({
      provider: "openai-codex",
      profileId: "openai-codex:legacy-default",
      credential: createCredential({ access: "", refresh: "same-refresh-token", email: undefined }),
    });

    expect(key.kind).toBe("refresh_hash");
    const keyParts = key.value.split("\u0000");
    expect(keyParts.slice(0, 2)).toEqual(["openai-codex", "refresh_hash"]);
    expect(keyParts[2]).toMatch(/^sha256-[a-f0-9]{64}$/u);
    expect(key.value).not.toContain("same-refresh-token");
  });

  it("falls back to provider/profile when no account signal exists", () => {
    expect(
      resolveOAuthRefreshCoordinationKey({
        provider: "openai-codex",
        profileId: "openai-codex:empty",
        credential: createCredential({ access: "", refresh: "", email: undefined }),
      }),
    ).toEqual({ kind: "profile", value: "openai-codex\u0000profile\u0000openai-codex:empty" });
  });
});

describe("findFreshOAuthCredentialForCoordinationKey", () => {
  it("finds a fresh same-account credential under another profile id without leaking token material", () => {
    const now = Date.now();
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai-codex:stale": createCredential({
          access: "stale-access",
          refresh: "stale-refresh",
          expires: now - 60_000,
          accountId: "acct-123",
        }),
        "openai-codex:fresh": createCredential({
          access: "fresh-access",
          refresh: "fresh-refresh",
          expires: now + 10 * 60_000,
          accountId: "acct-123",
        }),
      },
    };
    const key = resolveOAuthRefreshCoordinationKey({
      provider: "openai-codex",
      profileId: "openai-codex:stale",
      credential: store.profiles["openai-codex:stale"] as OAuthCredential,
    });

    const recovered = findFreshOAuthCredentialForCoordinationKey({
      store,
      provider: "openai-codex",
      coordinationKey: key,
      previous: store.profiles["openai-codex:stale"] as OAuthCredential,
    });

    expect(recovered).toEqual({
      profileId: "openai-codex:fresh",
      credential: expect.objectContaining({ access: "fresh-access" }),
    });
    expect(JSON.stringify({ key })).not.toContain("fresh-refresh");
    expect(JSON.stringify({ key })).not.toContain("stale-refresh");
  });
});
