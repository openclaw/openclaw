import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { withMSTeamsSqliteStateEnv, type MSTeamsSqliteStateOptions } from "./sqlite-state.js";

type MSTeamsSsoStoredToken = {
  /** Connection name from the Bot Framework OAuth connection setting. */
  connectionName: string;
  /** Stable user identifier (AAD object ID preferred). */
  userId: string;
  /** Exchanged user access token. */
  token: string;
  /** Expiration (ISO 8601) when the Bot Framework user token service reports one. */
  expiresAt?: string;
  /** ISO 8601 timestamp for the last successful exchange. */
  updatedAt: string;
};

export type MSTeamsSsoTokenStore = {
  get(params: { connectionName: string; userId: string }): Promise<MSTeamsSsoStoredToken | null>;
  save(token: MSTeamsSsoStoredToken): Promise<void>;
  remove(params: { connectionName: string; userId: string }): Promise<boolean>;
};

export const MSTEAMS_SSO_TOKEN_NAMESPACE = "sso-tokens";
const MSTEAMS_PLUGIN_ID = "msteams";
const STORE_KEY_VERSION_PREFIX = "v2:";

const ssoTokenStore = createPluginStateKeyedStore<MSTeamsSsoStoredToken>(MSTEAMS_PLUGIN_ID, {
  namespace: MSTEAMS_SSO_TOKEN_NAMESPACE,
  maxEntries: 20_000,
});

export function makeMSTeamsSsoTokenStoreKey(connectionName: string, userId: string): string {
  return `${STORE_KEY_VERSION_PREFIX}${Buffer.from(
    JSON.stringify([connectionName, userId]),
    "utf8",
  ).toString("base64url")}`;
}

export function createMSTeamsSsoTokenStore(
  params?: MSTeamsSqliteStateOptions,
): MSTeamsSsoTokenStore {
  return {
    async get({ connectionName, userId }) {
      return await withMSTeamsSqliteStateEnv(
        params,
        async () =>
          (await ssoTokenStore.lookup(makeMSTeamsSsoTokenStoreKey(connectionName, userId))) ?? null,
      );
    },

    async save(token) {
      await withMSTeamsSqliteStateEnv(params, async () => {
        await ssoTokenStore.register(
          makeMSTeamsSsoTokenStoreKey(token.connectionName, token.userId),
          { ...token },
        );
      });
    },

    async remove({ connectionName, userId }) {
      return await withMSTeamsSqliteStateEnv(params, async () => {
        return await ssoTokenStore.delete(makeMSTeamsSsoTokenStoreKey(connectionName, userId));
      });
    },
  };
}

/** In-memory store, primarily useful for tests. */
export function createMSTeamsSsoTokenStoreMemory(): MSTeamsSsoTokenStore {
  const tokens = new Map<string, MSTeamsSsoStoredToken>();
  return {
    async get({ connectionName, userId }) {
      return tokens.get(makeMSTeamsSsoTokenStoreKey(connectionName, userId)) ?? null;
    },
    async save(token) {
      tokens.set(makeMSTeamsSsoTokenStoreKey(token.connectionName, token.userId), { ...token });
    },
    async remove({ connectionName, userId }) {
      return tokens.delete(makeMSTeamsSsoTokenStoreKey(connectionName, userId));
    },
  };
}
