import { createHash } from "node:crypto";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export function createApiKeyCredential(
  provider: string,
  key: string,
): { type: "api_key"; provider: string; key: string } {
  return { type: "api_key", provider, key };
}

/** Build an OAuth credential fixture. */
export function oauthCred(params: {
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
}): OAuthCredential {
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
      "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-test" },
      "openai:api-key": { type: "api_key", provider: "openai", key: "sk-test-2" },
      "openai:default": {
        type: "oauth",
        provider: "openai",
        access: "codex-access-token",
        refresh: "codex-refresh-token",
        expires: 4_102_444_800_000,
        accountId: "acct_test_123",
      },
      "openrouter:default": { type: "api_key", provider: "openrouter", key: "sk-or-test" },
      "kilocode:default": { type: "api_key", provider: "kilocode", key: "sk-kc-test" },
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
