import type { resolveApiKeyForProfile } from "./oauth.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export const OAUTH_AGENT_ENV_KEYS = [
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
];

export function resolveApiKeyForProfileInTest(
  resolver: typeof resolveApiKeyForProfile,
  params: Omit<Parameters<typeof resolveApiKeyForProfile>[0], "cfg">,
) {
  return resolver({ cfg: {}, ...params });
}

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

export function storeWith(profileId: string, cred: OAuthCredential): AuthProfileStore {
  return { version: 1, profiles: { [profileId]: cred } };
}

export function createExpiredOauthStore(params: {
  profileId: string;
  provider: string;
  access?: string;
  refresh?: string;
  accountId?: string;
  email?: string;
}): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      [params.profileId]: {
        type: "oauth",
        provider: params.provider,
        access: params.access ?? "cached-access-token",
        refresh: params.refresh ?? "refresh-token",
        expires: Date.now() - 60_000,
        accountId: params.accountId,
        email: params.email,
      } satisfies OAuthCredential,
    },
  };
}
