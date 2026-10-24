import { createHash } from "node:crypto";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export function createApiKeyCredential(provider: string, key: string) {
  return { type: "api_key" as const, provider, key };
}

export function oauthCred(
  params: Pick<
    OAuthCredential,
    "provider" | "access" | "refresh" | "expires" | "accountId" | "email"
  >,
): OAuthCredential {
  return { type: "oauth", ...params };
}

export function createAuthProfileStoreFixture<Profiles>(profiles: Profiles) {
  return { version: 1, profiles };
}

export function createAuthProfileUsageStore(
  usageStats: AuthProfileStore["usageStats"],
): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": createApiKeyCredential("anthropic", "sk-test"),
      "openai:api-key": createApiKeyCredential("openai", "sk-test-2"),
      "openai:default": oauthCred({
        provider: "openai",
        access: "codex-access-token",
        refresh: "codex-refresh-token",
        expires: 4_102_444_800_000,
        accountId: "acct_test_123",
      }),
      "openrouter:default": createApiKeyCredential("openrouter", "sk-or-test"),
      "kilocode:default": createApiKeyCredential("kilocode", "sk-kc-test"),
    },
    usageStats,
  };
}

/** Stored claims stand in for an ID token verified by the provider before persistence. */
export function oidcIdentity(claims: Record<string, unknown> = {}) {
  const issuer = "https://issuer.example.test";
  const clientId = "client-test";
  const identity = { iss: issuer, aud: clientId, sub: "subject-a", ...claims };
  const payload = Buffer.from(JSON.stringify(identity)).toString("base64url");
  const accountId = createHash("sha256")
    .update(`${identity.iss}\0${identity.aud}\0${identity.sub}`)
    .digest("hex");
  return { issuer, clientId, accountId, idToken: `e30.${payload}.verified-by-provider` };
}

export function createOAuthRefreshCredential(
  overrides: Partial<OAuthCredential> = {},
): OAuthCredential {
  return {
    type: "oauth",
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    ...overrides,
  };
}

export function createUnresolvedOAuthCredential(provider = "openai"): OAuthCredential {
  return createOAuthRefreshCredential({
    provider,
    access: "",
    refresh: "",
    expires: 0,
    oauthRef: {
      source: "openclaw-credentials",
      provider: "openai-codex",
      id: "00000000000000000000000000000000",
    },
  });
}

export function oauthRefreshReplacementCases() {
  const mismatch = oidcIdentity({ sub: "subject-b" });
  return (
    [
      ["account mismatch", { accountId: "acct-a" }, { accountId: "acct-b" }, false, false],
      ["OIDC match", oidcIdentity(), oidcIdentity(), true, false],
      ["OIDC cold mismatch", oidcIdentity(), mismatch, false, true],
      ["OIDC cold observer", oidcIdentity(), oidcIdentity(), true, true],
    ] as const
  ).map(([kind, identity, replacementIdentity, sameIdentity, coldObserver]) => ({
    kind,
    identity,
    replacementIdentity,
    sameIdentity,
    coldObserver,
  }));
}

export function oauthRefreshFailureFallbackCases() {
  return (
    [
      ["rejects refresh-only changes", "failed-access", "new-refresh", undefined],
      ["adopts access-token changes", "new-access", "failed-refresh", "new-access"],
      [
        "preserves the refresh error when adopted-key construction fails",
        "new-access",
        "failed-refresh",
        undefined,
        "fallback key construction failed",
      ],
    ] as const
  ).map(([name, access, refresh, expectedApiKey, buildError]) => ({
    name,
    candidate: { access, refresh, expires: Date.now() + 600_000, accountId: "acct-123" },
    expectedApiKey,
    buildError,
  }));
}
