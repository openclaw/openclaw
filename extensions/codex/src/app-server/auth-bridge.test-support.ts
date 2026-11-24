import type { loadAuthProfileStoreForSecretsRuntime as loadStore } from "openclaw/plugin-sdk/agent-runtime";
import { fingerprintTokenAuthProfileCacheKey } from "./auth-cache-key.js";

export type AuthProfileStore = ReturnType<typeof loadStore>;
export type AuthProfileCredential = AuthProfileStore["profiles"][string];

export type OAuthProfile = Extract<AuthProfileCredential, { type: "oauth" }>;

export function oauthProfile(
  prefix: string,
  overrides: Partial<Omit<OAuthProfile, "type" | "provider">> = {},
): OAuthProfile {
  return {
    type: "oauth",
    provider: "openai",
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    // Fresh fixtures must outlive the proactive OAuth refresh window.
    expires: Date.now() + 24 * 60 * 60_000,
    ...overrides,
  };
}

export function authHandoff(access: string, chatgptAccountId: string) {
  return { accessFingerprint: fingerprintTokenAuthProfileCacheKey(access), chatgptAccountId };
}

export type Rotation = Pick<OAuthProfile, "access" | "refresh" | "expires">;
export type AccountRotation = Rotation & { accountId: string };
export function rotation(
  prefix: string,
  overrides: Partial<Rotation> & { accountId: string },
): AccountRotation;
export function rotation(prefix: string, overrides?: Partial<Rotation>): Rotation;
export function rotation(prefix: string, overrides: Partial<AccountRotation> = {}): Rotation {
  return {
    access: `${prefix}-access`,
    refresh: `${prefix}-refresh`,
    expires: Date.now() + 60_000,
    ...overrides,
  };
}
export function tokenResult(accessToken: string, chatgptAccountId: string) {
  return { accessToken, chatgptAccountId, chatgptPlanType: null };
}
