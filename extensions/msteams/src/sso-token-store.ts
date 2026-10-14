/**
 * SQLite-backed store for Bot Framework OAuth SSO tokens.
 *
 * Tokens are keyed by (connectionName, userId). `userId` should be the
 * stable AAD object ID (`activity.from.aadObjectId`) when available,
 * falling back to the Bot Framework `activity.from.id`.
 */

import { createHash } from "node:crypto";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsAccountStateNamespace,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";

type MSTeamsSsoStoredToken = {
  /** Connection name from the Bot Framework OAuth connection setting. */
  connectionName: string;
  /** Stable user identifier (AAD object ID preferred). */
  userId: string;
  token: string;
  /** Expiration (ISO 8601) when the Bot Framework user token service reports one. */
  expiresAt?: string;
  /** ISO 8601 timestamp for the last successful exchange. */
  updatedAt: string;
};

type MSTeamsSsoTokenStore = {
  get(params: { connectionName: string; userId: string }): Promise<MSTeamsSsoStoredToken | null>;
  save(value: MSTeamsSsoStoredToken): Promise<void>;
  remove(params: { connectionName: string; userId: string }): Promise<boolean>;
};

const MSTEAMS_SSO_TOKENS_NAMESPACE = "sso-tokens";
const MSTEAMS_MAX_SSO_TOKENS = 5000;
const STORE_KEY_VERSION_PREFIX = "v2:";

function makeMSTeamsSsoTokenStoreKey(connectionName: string, userId: string): string {
  return `${STORE_KEY_VERSION_PREFIX}${createHash("sha256")
    .update(JSON.stringify([connectionName, userId]))
    .digest("hex")}`;
}

export function createMSTeamsSsoTokenStoreFs(params?: {
  accountId?: string | null;
}): MSTeamsSsoTokenStore {
  const namespace = resolveMSTeamsAccountStateNamespace(
    MSTEAMS_SSO_TOKENS_NAMESPACE,
    params?.accountId,
  );
  const tokenStore = getMSTeamsRuntime().state.openKeyedStore<MSTeamsSsoStoredToken>({
    namespace,
    maxEntries: MSTEAMS_MAX_SSO_TOKENS,
  });

  return {
    async get({ connectionName, userId }) {
      return (await tokenStore.lookup(makeMSTeamsSsoTokenStoreKey(connectionName, userId))) ?? null;
    },

    async save(token) {
      await withMSTeamsSqliteMutationLock(namespace, async () => {
        await tokenStore.register(
          makeMSTeamsSsoTokenStoreKey(token.connectionName, token.userId),
          toPluginJsonValue({ ...token }),
        );
      });
    },

    async remove({ connectionName, userId }) {
      return withMSTeamsSqliteMutationLock(namespace, () =>
        tokenStore.delete(makeMSTeamsSsoTokenStoreKey(connectionName, userId)),
      );
    },
  };
}
