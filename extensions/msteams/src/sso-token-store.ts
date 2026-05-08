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

export const MSTEAMS_SSO_TOKEN_STORE_FILENAME = "msteams-sso-tokens.json";
export const MSTEAMS_SSO_TOKEN_NAMESPACE = "sso-tokens";
const MSTEAMS_PLUGIN_ID = "msteams";
const STORE_KEY_VERSION_PREFIX = "v2:";

const ssoTokenStore = createPluginStateKeyedStore<MSTeamsSsoStoredToken>(MSTEAMS_PLUGIN_ID, {
  namespace: MSTEAMS_SSO_TOKEN_NAMESPACE,
  maxEntries: 20_000,
});

function makeKey(connectionName: string, userId: string): string {
  return `${STORE_KEY_VERSION_PREFIX}${Buffer.from(
    JSON.stringify([connectionName, userId]),
    "utf8",
  ).toString("base64url")}`;
}

function normalizeStoredToken(value: unknown): MSTeamsSsoStoredToken | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const token = value as Partial<MSTeamsSsoStoredToken>;
  if (
    typeof token.connectionName !== "string" ||
    !token.connectionName ||
    typeof token.userId !== "string" ||
    !token.userId ||
    typeof token.token !== "string" ||
    !token.token ||
    typeof token.updatedAt !== "string" ||
    !token.updatedAt
  ) {
    return null;
  }
  return {
    connectionName: token.connectionName,
    userId: token.userId,
    token: token.token,
    ...(typeof token.expiresAt === "string" ? { expiresAt: token.expiresAt } : {}),
    updatedAt: token.updatedAt,
  };
}

export function parseMSTeamsSsoTokenStoreData(
  value: unknown,
): Record<string, MSTeamsSsoStoredToken> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1 || !obj.tokens || typeof obj.tokens !== "object") {
    return null;
  }
  const tokens: Record<string, MSTeamsSsoStoredToken> = {};
  for (const stored of Object.values(obj.tokens)) {
    const normalized = normalizeStoredToken(stored);
    if (!normalized) {
      continue;
    }
    tokens[makeKey(normalized.connectionName, normalized.userId)] = normalized;
  }
  return tokens;
}

export function createMSTeamsSsoTokenStore(
  params?: MSTeamsSqliteStateOptions,
): MSTeamsSsoTokenStore {
  return {
    async get({ connectionName, userId }) {
      return await withMSTeamsSqliteStateEnv(
        params,
        async () => (await ssoTokenStore.lookup(makeKey(connectionName, userId))) ?? null,
      );
    },

    async save(token) {
      await withMSTeamsSqliteStateEnv(params, async () => {
        await ssoTokenStore.register(makeKey(token.connectionName, token.userId), { ...token });
      });
    },

    async remove({ connectionName, userId }) {
      return await withMSTeamsSqliteStateEnv(params, async () => {
        return await ssoTokenStore.delete(makeKey(connectionName, userId));
      });
    },
  };
}

/** In-memory store, primarily useful for tests. */
export function createMSTeamsSsoTokenStoreMemory(): MSTeamsSsoTokenStore {
  const tokens = new Map<string, MSTeamsSsoStoredToken>();
  return {
    async get({ connectionName, userId }) {
      return tokens.get(makeKey(connectionName, userId)) ?? null;
    },
    async save(token) {
      tokens.set(makeKey(token.connectionName, token.userId), { ...token });
    },
    async remove({ connectionName, userId }) {
      return tokens.delete(makeKey(connectionName, userId));
    },
  };
}
