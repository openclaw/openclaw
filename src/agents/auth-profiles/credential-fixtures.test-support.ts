import type { OAuthCredential } from "./types.js";

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
