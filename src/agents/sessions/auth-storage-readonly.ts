import { getEnvApiKey } from "@openclaw/ai/internal/runtime";
import { getOAuthProviders } from "../../llm/utils/oauth/index.js";
import { isOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import type { AuthCredential, AuthStorageData } from "./auth-storage-types.js";
import type { AuthStorage } from "./auth-storage.js";

/** Catalog parsing observes credentials and modifiers; session mutation stays with AuthStorage. */
export type ReadonlyAuthStorage = Pick<AuthStorage, "get" | "hasAuth" | "getOAuthProviders">;

export function isAuthStorageOAuthRefreshFence(credential: AuthCredential | undefined): boolean {
  return credential?.type === "oauth" && isOAuthRefreshFence(credential);
}

export function hasAuthStorageCredential(
  provider: string,
  credential: AuthCredential | undefined,
): boolean {
  return Boolean(credential || getEnvApiKey(provider));
}

/** Detached like AuthStorage.inMemory, without a writable backend or refresh executor. */
export function createReadonlyAuthStorage(data: Readonly<AuthStorageData>): ReadonlyAuthStorage {
  // Match AuthStorage.inMemory's JSON serialization, including omitted undefined fields.
  // eslint-disable-next-line unicorn/prefer-structured-clone
  const credentials = JSON.parse(JSON.stringify(data)) as AuthStorageData;
  const get = (provider: string) => {
    const credential = credentials[provider];
    return isAuthStorageOAuthRefreshFence(credential) ? undefined : credential;
  };
  return {
    get,
    hasAuth: (provider) => hasAuthStorageCredential(provider, get(provider)),
    getOAuthProviders,
  };
}
