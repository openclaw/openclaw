import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  projectMcpOAuthCredentialsStatus,
  type McpOAuthPrincipalStatus,
} from "./mcp-oauth-status.js";
import { McpOAuthStoreCorruptionError } from "./mcp-oauth-store-error.js";
import type { McpOAuthStore } from "./mcp-oauth-store.types.js";

export type McpOAuthDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "mcp_oauth_pending_authorizations" | "mcp_oauth_stores"
>;

const MCP_OAUTH_STORE_FORMAT_VERSION = 1;
const UNINITIALIZED_STORE_FIELDS = new Set(["credentialState", "pendingAuthorizationChallenge"]);

function assertOptionalString(
  storeKey: string,
  store: Record<string, unknown>,
  field: "codeVerifier" | "lastAuthorizationUrl" | "redirectUrl",
): void {
  const value = store[field];
  if (value !== undefined && (typeof value !== "string" || value.length === 0)) {
    throw new McpOAuthStoreCorruptionError(storeKey, `${field} must be a non-empty string`);
  }
}

function assertDiscoveryState(storeKey: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value) || typeof value.authorizationServerUrl !== "string") {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState is invalid");
  }
  if (!URL.canParse(value.authorizationServerUrl)) {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState URLs are invalid");
  }
  if (
    value.resourceMetadataUrl !== undefined &&
    (typeof value.resourceMetadataUrl !== "string" || !URL.canParse(value.resourceMetadataUrl))
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState URLs are invalid");
  }
  if (
    value.resourceMetadata !== undefined &&
    !OAuthProtectedResourceMetadataSchema.safeParse(value.resourceMetadata).success
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "discoveryState resource metadata is invalid");
  }
  if (
    value.authorizationServerMetadata !== undefined &&
    !OAuthMetadataSchema.safeParse(value.authorizationServerMetadata).success &&
    !OpenIdProviderDiscoveryMetadataSchema.safeParse(value.authorizationServerMetadata).success
  ) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "discoveryState authorization server metadata is invalid",
    );
  }
}

function assertAuthorizationChallenge(storeKey: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new McpOAuthStoreCorruptionError(storeKey, "pendingAuthorizationChallenge is invalid");
  }
  const resourceMetadataUrl = value.resourceMetadataUrl;
  if (
    resourceMetadataUrl !== undefined &&
    (typeof resourceMetadataUrl !== "string" || !URL.canParse(resourceMetadataUrl))
  ) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "pendingAuthorizationChallenge URL is invalid",
    );
  }
  const scope = value.scope;
  if (scope !== undefined && (typeof scope !== "string" || scope.length === 0)) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "pendingAuthorizationChallenge scope is invalid",
    );
  }
  if (value.requiresAuthorization !== undefined && value.requiresAuthorization !== true) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "pendingAuthorizationChallenge requiresAuthorization must be true",
    );
  }
}

/** Parse a canonical row without discarding SDK extension fields. */
export function parseMcpOAuthStoreJson(storeKey: string, raw: string): McpOAuthStore {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new McpOAuthStoreCorruptionError(storeKey, "store_json is not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(value)) {
    throw new McpOAuthStoreCorruptionError(storeKey, "store_json must contain an object");
  }
  if (
    value.clientInformation !== undefined &&
    !OAuthClientInformationSchema.safeParse(value.clientInformation).success
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "clientInformation is invalid");
  }
  if (value.tokens !== undefined && !OAuthTokensSchema.safeParse(value.tokens).success) {
    throw new McpOAuthStoreCorruptionError(storeKey, "tokens are invalid");
  }
  if (
    value.credentialState !== undefined &&
    value.credentialState !== "uninitialized" &&
    value.credentialState !== "cleared"
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "credentialState is invalid");
  }
  if (value.credentialState !== undefined && value.tokens !== undefined) {
    throw new McpOAuthStoreCorruptionError(storeKey, "credentialState cannot coexist with tokens");
  }
  if (
    value.credentialState === "uninitialized" &&
    Object.keys(value).some((field) => !UNINITIALIZED_STORE_FIELDS.has(field))
  ) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "uninitialized credential state contains authoritative OAuth fields",
    );
  }
  if (
    value.tokenExpiresAt !== undefined &&
    (typeof value.tokenExpiresAt !== "number" ||
      !Number.isFinite(value.tokenExpiresAt) ||
      value.tokenExpiresAt < 0)
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "tokenExpiresAt is invalid");
  }
  if (value.tokenExpiresAt !== undefined && value.tokens === undefined) {
    throw new McpOAuthStoreCorruptionError(storeKey, "tokenExpiresAt requires tokens");
  }
  if (
    value.tokensAuthorizationServerUrl !== undefined &&
    (typeof value.tokensAuthorizationServerUrl !== "string" ||
      !URL.canParse(value.tokensAuthorizationServerUrl))
  ) {
    throw new McpOAuthStoreCorruptionError(storeKey, "tokensAuthorizationServerUrl is invalid");
  }
  if (value.tokensAuthorizationServerUrl !== undefined && value.tokens === undefined) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      "tokensAuthorizationServerUrl requires tokens",
    );
  }
  assertOptionalString(storeKey, value, "codeVerifier");
  assertOptionalString(storeKey, value, "lastAuthorizationUrl");
  assertOptionalString(storeKey, value, "redirectUrl");
  assertDiscoveryState(storeKey, value.discoveryState);
  assertAuthorizationChallenge(storeKey, value.pendingAuthorizationChallenge);
  // SAFETY: SDK schemas and the field guards above validate known fields; preserve extension fields.
  return value as McpOAuthStore;
}

function storeFromRow(
  storeKey: string,
  row: { format_version: number; store_json: string } | undefined,
): McpOAuthStore {
  if (!row) {
    return {};
  }
  if (row.format_version !== MCP_OAUTH_STORE_FORMAT_VERSION) {
    throw new McpOAuthStoreCorruptionError(
      storeKey,
      `unsupported format version ${row.format_version}`,
    );
  }
  return parseMcpOAuthStoreJson(storeKey, row.store_json);
}

export function readMcpOAuthStoreInDatabase(
  database: DatabaseSync,
  storeKey: string,
): McpOAuthStore {
  const row = executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .selectFrom("mcp_oauth_stores")
      .select(["format_version", "store_json"])
      .where("store_key", "=", storeKey),
  );
  return storeFromRow(storeKey, row);
}

export const MCP_OAUTH_PENDING_STATE_TTL_MS = 10 * 60 * 1000;

export type McpOAuthReadOperations = {
  "mcpOAuth.read": { input: string; output: McpOAuthStore };
};

export type McpOAuthReadOnlyOperations = {
  "mcpOAuth.statuses": { input: readonly string[]; output: McpOAuthPrincipalStatus[] };
  "mcpOAuth.readOnly": { input: string; output: McpOAuthStore };
  "mcpOAuth.keys": { input: string; output: string[] };
  "mcpOAuth.pending": { input: string; output: string | undefined };
  "mcpOAuth.countPrincipals": { input: string; output: number };
};

export function readMcpOAuthStoreIfPresentInDatabase(
  database: DatabaseSync,
  storeKey: string,
): McpOAuthStore {
  return tableExists(database, "mcp_oauth_stores")
    ? readMcpOAuthStoreInDatabase(database, storeKey)
    : {};
}

export function readMcpOAuthStatusesInDatabase(
  database: DatabaseSync,
  storeKeys: readonly string[],
): McpOAuthPrincipalStatus[] {
  if (!tableExists(database, "mcp_oauth_stores")) {
    return storeKeys.map(() => projectMcpOAuthCredentialsStatus({}));
  }
  const rows = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .selectFrom("mcp_oauth_stores")
      .select(["store_key", "format_version", "store_json"])
      .where("store_key", "in", sqliteStringSet(storeKeys)),
  ).rows;
  const rowsByKey = new Map(rows.map((row) => [row.store_key, row]));
  // Decode in caller order so a corrupt row reports the same first failing principal.
  return storeKeys.map((storeKey) =>
    projectMcpOAuthCredentialsStatus(storeFromRow(storeKey, rowsByKey.get(toUSVString(storeKey)))),
  );
}

export function listMcpOAuthStoreKeysInDatabase(database: DatabaseSync, prefix: string): string[] {
  if (!tableExists(database, "mcp_oauth_stores")) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .selectFrom("mcp_oauth_stores")
      .select("store_key")
      .where((eb) => eb(eb.fn<number>("instr", [eb.ref("store_key"), eb.val(prefix)]), "=", 1))
      .orderBy("store_key", "asc"),
  ).rows;
  return rows.map((row) => row.store_key);
}

export function countMcpOAuthPrincipalsInDatabase(database: DatabaseSync, prefix: string): number {
  if (!tableExists(database, "mcp_oauth_stores")) {
    return 0;
  }
  const rows = iterateSqliteQuerySync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .selectFrom("mcp_oauth_stores")
      .select(["store_key", "format_version", "store_json"])
      .where((eb) => eb(eb.fn<number>("instr", [eb.ref("store_key"), eb.val(prefix)]), "=", 1))
      .orderBy("store_key", "asc"),
  );
  let count = 0;
  for (const row of rows) {
    if (storeFromRow(row.store_key, row).tokens !== undefined) {
      count++;
    }
  }
  return count;
}

export function readMcpOAuthPendingInDatabase(
  database: DatabaseSync,
  state: string,
): string | undefined {
  if (!tableExists(database, "mcp_oauth_pending_authorizations")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .selectFrom("mcp_oauth_pending_authorizations")
      .select("store_key")
      .where("state", "=", state)
      .where("create_time", ">", Date.now() - MCP_OAUTH_PENDING_STATE_TTL_MS),
  )?.store_key;
}

export function replaceMcpOAuthStoreInDatabase(
  database: DatabaseSync,
  storeKey: string,
  next: McpOAuthStore,
  assertOwnedInTransaction?: (database: DatabaseSync) => void,
): McpOAuthStore {
  const storeJson = JSON.stringify(next);
  parseMcpOAuthStoreJson(storeKey, storeJson);
  assertOwnedInTransaction?.(database);
  const updatedAt = Date.now();
  executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<McpOAuthDatabase>(database)
      .insertInto("mcp_oauth_stores")
      .values({
        store_key: storeKey,
        format_version: MCP_OAUTH_STORE_FORMAT_VERSION,
        store_json: storeJson,
        updated_at: updatedAt,
      })
      .onConflict((conflict) =>
        conflict.column("store_key").doUpdateSet({
          format_version: MCP_OAUTH_STORE_FORMAT_VERSION,
          store_json: storeJson,
          updated_at: updatedAt,
        }),
      ),
  );
  return next;
}
