import { isDeepStrictEqual } from "node:util";
import type { OAuthProviderId } from "../../llm/utils/oauth/types.js";
import { OAUTH_REFRESH_CALL_TIMEOUT_MS } from "../auth-profiles/constants.js";
import {
  normalizeOAuthRefreshCredential,
  refreshSerializedOAuthCredential,
} from "../auth-profiles/oauth-refresh-fence.js";
import { isOAuthRefreshFence } from "../auth-profiles/oauth-refresh-marker.js";
import { AuthStoragePersistenceError } from "./auth-storage-error.js";
import {
  canResolveAuthStoragePluginOAuthRefresh,
  getAuthStorageOAuthProviderRegistry,
  resolveAuthStoragePluginOAuthCredential,
} from "./auth-storage-oauth-registry.js";
import type {
  AuthCredential,
  AuthStorageBackend,
  AuthStorageData,
  OAuthCredential,
} from "./auth-storage-types.js";

export function isAuthStorageOAuthRefreshFence(
  provider: string,
  credential: AuthCredential | undefined,
): boolean {
  return (
    credential?.type === "oauth" &&
    isOAuthRefreshFence(normalizeOAuthRefreshCredential(credential, provider))
  );
}

export async function refreshAuthStorageOAuthCredential(params: {
  authStorage: object;
  storage: AuthStorageBackend;
  providerId: OAuthProviderId;
  parse: (current: string | undefined) => AuthStorageData;
  commit: (data: AuthStorageData) => void;
}): Promise<{ apiKey: string; newCredentials: OAuthCredential } | null> {
  const provider = getAuthStorageOAuthProviderRegistry(params.authStorage).get(params.providerId);
  const result = await refreshSerializedOAuthCredential({
    backend: params.storage,
    provider: params.providerId,
    profileId: `${params.providerId}:default`,
    label: `AuthStorage.refresh(${params.providerId})`,
    timeoutMs: OAUTH_REFRESH_CALL_TIMEOUT_MS,
    parse: params.parse,
    serialize: (data) => JSON.stringify(data, null, 2),
    readCredential: (data) => {
      const credential = data[params.providerId];
      return normalizeOAuthRefreshCredential(
        credential?.type === "oauth" ? credential : undefined,
        params.providerId,
      );
    },
    writeCredential: (data, credential) => ({
      ...data,
      [params.providerId]: credential,
    }),
    canRefresh: async () =>
      Boolean(provider) || (await canResolveAuthStoragePluginOAuthRefresh(params.providerId)),
    commit: (data) => {
      const expected = params.parse(JSON.stringify(data));
      const current = params.storage.withLock((raw) => {
        const authoritative = params.parse(raw);
        if (!isDeepStrictEqual(authoritative[params.providerId], expected[params.providerId])) {
          throw new AuthStoragePersistenceError(
            "Auth storage credentials changed before refresh publication.",
            undefined,
          );
        }
        return { result: authoritative };
      });
      // Backend completion captures credential sources before runtime publication.
      params.commit(current);
    },
    refresh: async (credential, data) => {
      const oauthCredentials = Object.fromEntries(
        Object.entries(data).filter((entry): entry is [string, OAuthCredential] => {
          return entry[1].type === "oauth";
        }),
      );
      const refreshed = provider
        ? await getAuthStorageOAuthProviderRegistry(params.authStorage).getApiKey(
            params.providerId,
            oauthCredentials,
          )
        : await resolveAuthStoragePluginOAuthCredential(params.providerId, credential, true);
      return refreshed
        ? {
            apiKey: refreshed.apiKey,
            credential: {
              ...credential,
              ...refreshed.newCredentials,
              type: "oauth",
              provider: credential.provider,
            },
          }
        : null;
    },
    resolve: async (credential) => {
      if (provider) {
        return { apiKey: provider.getApiKey(credential), credential };
      }
      const resolved = await resolveAuthStoragePluginOAuthCredential(
        params.providerId,
        credential,
        false,
      );
      return resolved
        ? {
            apiKey: resolved.apiKey,
            credential: {
              ...credential,
              ...resolved.newCredentials,
              type: "oauth",
              provider: credential.provider,
            },
          }
        : null;
    },
  });
  return result ? { apiKey: result.apiKey, newCredentials: result.credential } : null;
}
