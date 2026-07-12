// Persists MCP App view snapshots outside transcripts in the shared state DB.
import { randomBytes } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { isRecord } from "../utils.js";
import type { McpAppCsp, McpAppToolDetails, McpAppViewPayload } from "./mcp-apps.js";

const MCP_APP_VIEW_ID_PREFIX = "mcpview_";
export const MCP_APP_VIEW_ID_PATTERN = /^mcpview_[A-Za-z0-9_-]{32}$/;
export const MCP_APP_VIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MCP_APP_VIEW_MAX_ENTRIES = 128;
export const MCP_APP_VIEW_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const MCP_APP_VIEW_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MCP_APP_VIEW_NAME_MAX_CHARS = 256;
const MCP_APP_VIEW_RESOURCE_URI_MAX_CHARS = 2_048;
const MCP_APP_VIEW_MIME_TYPE_MAX_CHARS = 256;

type McpAppViewsDatabase = Pick<OpenClawStateKyselyDatabase, "mcp_app_views">;

type McpAppViewStoreOptions = {
  databasePath?: string;
  nowMs?: number;
  ttlMs?: number;
  maxEntries?: number;
  maxTotalBytes?: number;
};

type StoredMcpAppMetadata = {
  csp?: McpAppCsp;
  permissions?: string[];
  prefersBorder?: boolean;
  toolInput?: unknown;
  result: McpAppViewPayload["result"];
};

function stateDbOptions(options: McpAppViewStoreOptions) {
  return options.databasePath ? { path: options.databasePath } : {};
}

function getMcpAppViewsDb(database: ReturnType<typeof openOpenClawStateDatabase>) {
  return getNodeSqliteKysely<McpAppViewsDatabase>(database.db);
}

function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function serializeMetadata(payload: McpAppViewPayload): string | undefined {
  const metadata: StoredMcpAppMetadata = {
    ...(payload.resource.csp ? { csp: payload.resource.csp } : {}),
    ...(payload.resource.permissions ? { permissions: payload.resource.permissions } : {}),
    ...(payload.resource.prefersBorder === true ? { prefersBorder: true } : {}),
    ...(payload.toolInput !== undefined ? { toolInput: payload.toolInput } : {}),
    result: payload.result,
  };
  try {
    return JSON.stringify(metadata);
  } catch {
    return undefined;
  }
}

function pruneMcpAppViews(params: {
  database: ReturnType<typeof openOpenClawStateDatabase>;
  nowMs: number;
  preserveViewId: string;
  maxEntries: number;
  maxTotalBytes: number;
}): void {
  const views = getMcpAppViewsDb(params.database);
  executeSqliteQuerySync(
    params.database.db,
    views.deleteFrom("mcp_app_views").where("expires_at_ms", "<=", params.nowMs),
  );
  const rows = executeSqliteQuerySync(
    params.database.db,
    views
      .selectFrom("mcp_app_views")
      .select(["view_id", "size_bytes"])
      .orderBy("created_at_ms", "asc")
      .orderBy("view_id", "asc"),
  ).rows;
  let remainingEntries = rows.length;
  let remainingBytes = rows.reduce((total, row) => total + row.size_bytes, 0);
  const deleteIds: string[] = [];
  for (const row of rows) {
    if (remainingEntries <= params.maxEntries && remainingBytes <= params.maxTotalBytes) {
      break;
    }
    if (row.view_id === params.preserveViewId) {
      continue;
    }
    deleteIds.push(row.view_id);
    remainingEntries -= 1;
    remainingBytes -= row.size_bytes;
  }
  if (deleteIds.length > 0) {
    executeSqliteQuerySync(
      params.database.db,
      views.deleteFrom("mcp_app_views").where("view_id", "in", deleteIds),
    );
  }
}

/** Store one app view and return the small descriptor safe for transcript persistence. */
export function storeMcpAppView(
  payload: McpAppViewPayload,
  options: McpAppViewStoreOptions = {},
): McpAppToolDetails | undefined {
  const metadataJson = serializeMetadata(payload);
  if (!metadataJson) {
    return undefined;
  }
  if (
    !payload.serverName ||
    payload.serverName.length > MCP_APP_VIEW_NAME_MAX_CHARS ||
    !payload.toolName ||
    payload.toolName.length > MCP_APP_VIEW_NAME_MAX_CHARS ||
    !payload.resource.uri ||
    payload.resource.uri.length > MCP_APP_VIEW_RESOURCE_URI_MAX_CHARS ||
    !payload.resource.mimeType ||
    payload.resource.mimeType.length > MCP_APP_VIEW_MIME_TYPE_MAX_CHARS
  ) {
    return undefined;
  }
  const html = Buffer.from(payload.resource.html, "utf8");
  const maxTotalBytes = normalizePositiveLimit(options.maxTotalBytes, MCP_APP_VIEW_MAX_TOTAL_BYTES);
  const sizeBytes =
    html.byteLength +
    Buffer.byteLength(metadataJson, "utf8") +
    Buffer.byteLength(payload.serverName, "utf8") +
    Buffer.byteLength(payload.toolName, "utf8") +
    Buffer.byteLength(payload.resource.uri, "utf8") +
    Buffer.byteLength(payload.resource.mimeType, "utf8");
  if (sizeBytes > MCP_APP_VIEW_MAX_PAYLOAD_BYTES || sizeBytes > maxTotalBytes) {
    return undefined;
  }
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = normalizePositiveLimit(options.ttlMs, MCP_APP_VIEW_TTL_MS);
  const maxEntries = normalizePositiveLimit(options.maxEntries, MCP_APP_VIEW_MAX_ENTRIES);
  const viewId = `${MCP_APP_VIEW_ID_PREFIX}${randomBytes(24).toString("base64url")}`;
  const inserted = runOpenClawStateWriteTransaction((database) => {
    const views = getMcpAppViewsDb(database);
    const result = executeSqliteQuerySync(
      database.db,
      views
        .insertInto("mcp_app_views")
        .values({
          view_id: viewId,
          server_name: payload.serverName,
          tool_name: payload.toolName,
          resource_uri: payload.resource.uri,
          mime_type: payload.resource.mimeType,
          html,
          metadata_json: metadataJson,
          size_bytes: sizeBytes,
          created_at_ms: nowMs,
          expires_at_ms: nowMs + ttlMs,
        })
        .onConflict((conflict) => conflict.column("view_id").doNothing()),
    );
    if (result.numAffectedRows !== 1n) {
      return false;
    }
    pruneMcpAppViews({
      database,
      nowMs,
      preserveViewId: viewId,
      maxEntries,
      maxTotalBytes,
    });
    return true;
  }, stateDbOptions(options));
  if (!inserted) {
    return undefined;
  }
  return {
    viewId,
    serverName: payload.serverName,
    toolName: payload.toolName,
    ...(payload.resource.uri ? { resourceUri: payload.resource.uri } : {}),
  };
}

function parseStoredMetadata(raw: string): StoredMcpAppMetadata | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.result)) {
      return undefined;
    }
    return parsed as StoredMcpAppMetadata;
  } catch {
    return undefined;
  }
}

/** Load one unexpired view snapshot by its unguessable transcript descriptor. */
export function loadMcpAppView(
  viewId: string,
  options: Pick<McpAppViewStoreOptions, "databasePath" | "nowMs"> = {},
): McpAppViewPayload | undefined {
  if (!MCP_APP_VIEW_ID_PATTERN.test(viewId)) {
    return undefined;
  }
  const nowMs = options.nowMs ?? Date.now();
  const row = runOpenClawStateWriteTransaction((database) => {
    const views = getMcpAppViewsDb(database);
    executeSqliteQuerySync(
      database.db,
      views.deleteFrom("mcp_app_views").where("expires_at_ms", "<=", nowMs),
    );
    return executeSqliteQueryTakeFirstSync(
      database.db,
      views
        .selectFrom("mcp_app_views")
        .select(["server_name", "tool_name", "resource_uri", "mime_type", "html", "metadata_json"])
        .where("view_id", "=", viewId),
    );
  }, stateDbOptions(options));
  if (!row) {
    return undefined;
  }
  const metadata = parseStoredMetadata(row.metadata_json);
  if (!metadata) {
    return undefined;
  }
  return {
    serverName: row.server_name,
    toolName: row.tool_name,
    resource: {
      uri: row.resource_uri,
      mimeType: row.mime_type,
      html: Buffer.from(row.html).toString("utf8"),
      ...(metadata.csp ? { csp: metadata.csp } : {}),
      ...(metadata.permissions ? { permissions: metadata.permissions } : {}),
      ...(metadata.prefersBorder === true ? { prefersBorder: true } : {}),
    },
    ...(metadata.toolInput !== undefined ? { toolInput: metadata.toolInput } : {}),
    result: metadata.result,
  };
}
