import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import { normalizeComposioToolkitSlug } from "@/lib/composio-normalization";
import { readConfiguredDenchCloudSettings } from "../../../src/cli/dench-cloud";

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const parsed = readString(value);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ComposioToolkit = {
  slug: string;
  connect_slug?: string | null;
  name: string;
  description: string;
  logo: string | null;
  categories: string[];
  auth_schemes: string[];
  tools_count: number;
};

export type ComposioToolkitRecord = {
  slug?: string | null;
  name?: string | null;
  description?: string | null;
  description_short?: string | null;
  summary?: string | null;
  logo?: string | null;
  logo_url?: string | null;
  icon?: string | null;
  image?: string | null;
  categories?: string[] | null;
  auth_schemes?: string[] | null;
  authSchemes?: string[] | null;
  tools_count?: number | null;
  toolsCount?: number | null;
  meta?: {
    logo?: string | null;
    description?: string | null;
    categories?: string[] | null;
    [key: string]: unknown;
  } | null;
};

export type ComposioIdentityConfidence = "high" | "low" | "unknown";
export type ComposioReconnectClaim = "same" | "different" | "unknown";
export type ComposioReconnectConfidence = "high" | "unknown";

export type ComposioConnectionToolkit = {
  slug?: string | null;
  name?: string | null;
};

export type ComposioConnectionRawIds = {
  externalAccountId?: string | null;
  providerAccountId?: string | null;
  providerUserId?: string | null;
  workspaceId?: string | null;
  teamId?: string | null;
  tenantId?: string | null;
  organizationId?: string | null;
};

export type ComposioConnectionAccount = {
  stableId?: string | null;
  confidence?: ComposioIdentityConfidence;
  label?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  rawIds?: ComposioConnectionRawIds;
};

export type ComposioConnectionReconnect = {
  claim?: ComposioReconnectClaim;
  confidence?: ComposioReconnectConfidence;
  relatedConnectionIds?: string[];
};

export type ComposioConnectionRecord = {
  id?: string | null;
  connectionId?: string | null;
  toolkit_slug?: string | null;
  toolkit_name?: string | null;
  toolkit?: ComposioConnectionToolkit;
  status?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  updated_at?: string | null;
  updatedAt?: string | null;
  account_label?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  external_account_id?: string | null;
  account_stable_id?: string | null;
  account?: ComposioConnectionAccount;
  reconnect?: ComposioConnectionReconnect;
};

export type ComposioConnection = {
  id: string;
  toolkit_slug: string;
  toolkit_name: string;
  status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE" | string;
  created_at: string;
  updated_at?: string | null;
  account_label?: string | null;
  account_name?: string | null;
  account_email?: string | null;
  external_account_id?: string | null;
  account_stable_id?: string | null;
  toolkit?: ComposioConnectionToolkit;
  account?: ComposioConnectionAccount;
  reconnect?: ComposioConnectionReconnect;
};

export type ComposioToolkitsResponse = {
  items: ComposioToolkitRecord[];
  cursor?: string | null;
  total?: number;
  categories?: string[];
  toolkits?: ComposioToolkitRecord[];
  data?: ComposioToolkitRecord[];
  next_cursor?: string | null;
  nextCursor?: string | null;
  total_items?: number;
};

export type ComposioConnectionsResponse = {
  items?: ComposioConnectionRecord[];
  connections?: ComposioConnectionRecord[];
  raw?: unknown;
};

export type ComposioConnectResponse = {
  redirect_url: string;
  connection_id: string | null;
};

export type ComposioState = {
  eligible: boolean;
  lockReason: "missing_dench_key" | "dench_not_primary" | null;
  lockBadge: string | null;
  toolkits: ComposioToolkit[];
  connections: ComposioConnection[];
  categories: string[];
};

export type NormalizedComposioConnection = ComposioConnection & {
  normalized_toolkit_slug: string;
  normalized_status: string;
  is_active: boolean;
  account_identity: string;
  account_identity_source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  identity_confidence: ComposioIdentityConfidence;
  display_label: string;
  reconnect_claim: ComposioReconnectClaim;
  reconnect_confidence: ComposioReconnectConfidence;
  related_connection_ids: string[];
  is_same_account_reconnect: boolean;
};

export function normalizeComposioConnectionStatus(status: unknown): string {
  return typeof status === "string" && status.trim()
    ? status.trim().toUpperCase()
    : "UNKNOWN";
}

function buildComposioConnectionDisplayLabel(connection: ComposioConnection): string {
  const label = [
    connection.account_label,
    connection.account_name,
    connection.account_email,
    connection.account?.label,
    connection.account?.email,
  ].find((value) => typeof value === "string" && value.trim());

  if (label) {
    return label;
  }

  return `Connection ${connection.id.slice(-6)}`;
}

function buildComposioConnectionIdentity(connection: ComposioConnection): {
  value: string;
  source: "gateway_stable_id" | "legacy_heuristic" | "connection_id";
  confidence: ComposioIdentityConfidence;
} {
  const gatewayStableId = pickString(
    connection.account_stable_id,
    connection.account?.stableId,
  );
  if (gatewayStableId) {
    return {
      value: gatewayStableId,
      source: "gateway_stable_id",
      confidence: connection.account?.confidence ?? "high",
    };
  }

  const stableIdentity = [
    connection.external_account_id,
    connection.account_email,
    connection.account_name,
    connection.account_label,
  ].find((value) => typeof value === "string" && value.trim());

  if (stableIdentity) {
    return {
      value: `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${stableIdentity.trim().toLowerCase()}`,
      source: "legacy_heuristic",
      confidence: connection.external_account_id ? "high" : "low",
    };
  }

  return {
    value: `${normalizeComposioToolkitSlug(connection.toolkit_slug)}:${connection.id}`,
    source: "connection_id",
    confidence: "unknown",
  };
}

export function normalizeComposioConnection(
  connection: ComposioConnection,
): NormalizedComposioConnection {
  const normalized_status = normalizeComposioConnectionStatus(connection.status);
  const identity = buildComposioConnectionIdentity(connection);
  const reconnect_claim = connection.reconnect?.claim ?? "unknown";
  const reconnect_confidence = connection.reconnect?.confidence ?? "unknown";
  const related_connection_ids = connection.reconnect?.relatedConnectionIds ?? [];

  return {
    ...connection,
    normalized_toolkit_slug: normalizeComposioToolkitSlug(connection.toolkit_slug),
    normalized_status,
    is_active: normalized_status === "ACTIVE",
    account_identity: identity.value,
    account_identity_source: identity.source,
    identity_confidence: identity.confidence,
    display_label: buildComposioConnectionDisplayLabel(connection),
    reconnect_claim,
    reconnect_confidence,
    related_connection_ids,
    is_same_account_reconnect:
      reconnect_claim === "same" && reconnect_confidence === "high",
  };
}

function parseComposioConnectionTime(connection: ComposioConnection): number {
  const timestamp = Date.parse(connection.created_at);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortComposioConnections(
  left: NormalizedComposioConnection,
  right: NormalizedComposioConnection,
): number {
  if (left.is_active !== right.is_active) {
    return left.is_active ? -1 : 1;
  }

  const timeDiff = parseComposioConnectionTime(right) - parseComposioConnectionTime(left);
  if (timeDiff !== 0) {
    return timeDiff;
  }

  return left.display_label.localeCompare(right.display_label);
}

export function normalizeComposioConnections(
  connections: ComposioConnection[],
): NormalizedComposioConnection[] {
  return connections.map(normalizeComposioConnection).sort(sortComposioConnections);
}

// ---------------------------------------------------------------------------
// Config resolution (mirrors integrations.ts patterns)
// ---------------------------------------------------------------------------

function readConfig(): UnknownRecord {
  const configPath = join(resolveOpenClawStateDir(), "openclaw.json");
  if (!existsSync(configPath)) return {};
  try {
    return (JSON.parse(readFileSync(configPath, "utf-8")) as UnknownRecord) ?? {};
  } catch {
    return {};
  }
}

export function resolveComposioGatewayUrl(): string {
  const config = readConfig();
  const settings = readConfiguredDenchCloudSettings(config);
  const plugins = asRecord(config.plugins);
  const pluginEntries = asRecord(plugins?.entries);
  const gatewayConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  return (
    settings.gatewayUrl ||
    readString(gatewayConfig?.gatewayUrl) ||
    process.env.DENCH_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

export function resolveComposioApiKey(): string | null {
  const config = readConfig();
  const models = asRecord(config.models);
  const provider = asRecord(asRecord(models?.providers)?.["dench-cloud"]);
  if (readString(provider?.apiKey)) {
    return readString(provider?.apiKey) ?? null;
  }
  if (process.env.DENCH_CLOUD_API_KEY?.trim()) {
    return process.env.DENCH_CLOUD_API_KEY.trim();
  }
  if (process.env.DENCH_API_KEY?.trim()) {
    return process.env.DENCH_API_KEY.trim();
  }
  return null;
}

export function resolveComposioEligibility(): {
  eligible: boolean;
  lockReason: "missing_dench_key" | "dench_not_primary" | null;
  lockBadge: string | null;
} {
  const config = readConfig();
  const apiKey = resolveComposioApiKey();
  if (!apiKey) {
    return {
      eligible: false,
      lockReason: "missing_dench_key",
      lockBadge: "Get Dench Cloud API Key",
    };
  }
  const agents = asRecord(config.agents);
  const defaults = asRecord(agents?.defaults);
  const model = defaults?.model;
  const primary = typeof model === "string"
    ? readString(model)
    : readString(asRecord(model)?.primary);
  if (!primary?.startsWith("dench-cloud/")) {
    return {
      eligible: false,
      lockReason: "dench_not_primary",
      lockBadge: "Use Dench Cloud",
    };
  }
  return { eligible: true, lockReason: null, lockBadge: null };
}

// ---------------------------------------------------------------------------
// Gateway client helpers
// ---------------------------------------------------------------------------

async function gatewayFetch(
  gatewayUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${gatewayUrl}${path}`;
  return fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...init?.headers,
    },
  });
}

export type FetchToolkitsOptions = {
  search?: string;
  category?: string;
  cursor?: string;
  limit?: number;
};

function normalizeToolkitsEnvelope(raw: ComposioToolkitsResponse): ComposioToolkitsResponse {
  const items = raw.items?.length
    ? raw.items
    : raw.toolkits?.length
      ? raw.toolkits
      : raw.data ?? [];
  const cursor = raw.cursor ?? raw.next_cursor ?? raw.nextCursor ?? null;
  const total = raw.total ?? raw.total_items;
  return {
    items,
    cursor,
    total,
    categories: raw.categories,
  };
}

export async function fetchComposioToolkits(
  gatewayUrl: string,
  apiKey: string,
  options?: FetchToolkitsOptions,
): Promise<ComposioToolkitsResponse> {
  const params = new URLSearchParams();
  if (options?.search) params.set("search", options.search);
  if (options?.category) params.set("category", options.category);
  if (options?.cursor) params.set("cursor", options.cursor);
  if (options?.limit) params.set("limit", String(options.limit));
  const qs = params.toString();
  const path = `/v1/composio/toolkits${qs ? `?${qs}` : ""}`;
  const res = await gatewayFetch(gatewayUrl, apiKey, path);
  if (!res.ok) {
    throw new Error(`Failed to fetch toolkits (HTTP ${res.status})`);
  }
  const raw = (await res.json()) as ComposioToolkitsResponse;
  return normalizeToolkitsEnvelope(raw);
}

export async function fetchComposioConnections(
  gatewayUrl: string,
  apiKey: string,
): Promise<ComposioConnectionsResponse> {
  const res = await gatewayFetch(gatewayUrl, apiKey, "/v1/composio/connections");
  if (!res.ok) {
    throw new Error(`Failed to fetch connections (HTTP ${res.status})`);
  }
  return res.json() as Promise<ComposioConnectionsResponse>;
}

export async function initiateComposioConnect(
  gatewayUrl: string,
  apiKey: string,
  toolkit: string,
  callbackUrl: string,
): Promise<ComposioConnectResponse> {
  const res = await gatewayFetch(gatewayUrl, apiKey, "/v1/composio/connect", {
    method: "POST",
    body: JSON.stringify({ toolkit, callback_url: callbackUrl }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Failed to initiate connection for ${toolkit} (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return res.json() as Promise<ComposioConnectResponse>;
}

export async function disconnectComposioApp(
  gatewayUrl: string,
  apiKey: string,
  connectionId: string,
): Promise<{ deleted: boolean }> {
  const res = await gatewayFetch(
    gatewayUrl,
    apiKey,
    `/v1/composio/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    throw new Error(`Failed to disconnect (HTTP ${res.status})`);
  }
  return res.json() as Promise<{ deleted: boolean }>;
}

// ---------------------------------------------------------------------------
// Composio MCP (Streamable HTTP) — tools/list for tool index builder
// ---------------------------------------------------------------------------

export type ComposioMcpTool = {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
};

function extractToolsFromJsonRpcMessage(payload: unknown): {
  tools: ComposioMcpTool[];
  nextCursor: string | null;
} {
  const rec = asRecord(payload);
  const result = asRecord(rec?.result);
  const tools = result?.tools;
  if (!Array.isArray(tools)) {
    return {
      tools: [],
      nextCursor: readString(result?.next_cursor ?? result?.nextCursor ?? result?.cursor) ?? null,
    };
  }

  const out: ComposioMcpTool[] = [];
  for (const item of tools) {
    const t = asRecord(item);
    const name = readString(t?.name);
    if (!name) {
      continue;
    }
    out.push({
      name,
      description: readString(t?.description),
      title: readString(t?.title ?? asRecord(t?.annotations)?.title),
      inputSchema: t?.inputSchema as ComposioMcpTool["inputSchema"],
      annotations: t?.annotations as ComposioMcpTool["annotations"],
    });
  }
  return {
    tools: out,
    nextCursor: readString(result?.next_cursor ?? result?.nextCursor ?? result?.cursor) ?? null,
  };
}

function parseSseJsonRpcTools(body: string): {
  tools: ComposioMcpTool[];
  nextCursor: string | null;
} {
  const lines = body.split(/\r?\n/);
  let lastPayload: unknown = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const raw = trimmed.slice(5).trim();
    if (raw === "[DONE]" || raw === "") {
      continue;
    }
    try {
      lastPayload = JSON.parse(raw);
    } catch {
      // ignore non-JSON SSE frames
    }
  }
  if (lastPayload === null) {
    return { tools: [], nextCursor: null };
  }
  return extractToolsFromJsonRpcMessage(lastPayload);
}

async function parseMcpToolsListResponse(res: Response): Promise<{
  tools: ComposioMcpTool[];
  nextCursor: string | null;
}> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (contentType.includes("text/event-stream")) {
    const fromSse = parseSseJsonRpcTools(text);
    if (fromSse.tools.length > 0 || fromSse.nextCursor) {
      return fromSse;
    }
  }
  try {
    return extractToolsFromJsonRpcMessage(JSON.parse(text) as unknown);
  } catch {
    return parseSseJsonRpcTools(text);
  }
}

/**
 * Lists all tools exposed by the Composio MCP bridge on the gateway (JSON-RPC `tools/list`).
 */
export async function fetchComposioMcpToolsList(
  gatewayUrl: string,
  apiKey: string,
  options?: {
    connectedToolkits?: string[];
    preferredToolNames?: string[];
  },
): Promise<ComposioMcpTool[]> {
  const url = `${gatewayUrl.replace(/\/$/, "")}/v1/composio/mcp`;
  const connectedToolkits = options?.connectedToolkits?.filter((slug) => slug.trim().length > 0) ?? [];
  const preferredToolNames = options?.preferredToolNames?.filter((name) => name.trim().length > 0) ?? [];
  const seen = new Set<string>();
  const out: ComposioMcpTool[] = [];
  let cursor: string | null = null;

  while (true) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        // Forward-compatible hint payload for the external gateway. The current
        // MCP bridge may ignore these fields; a filtered gateway implementation
        // can use them to prioritize connected-app tools without changing the
        // client contract.
        params: {
          ...(connectedToolkits.length > 0 ? { connected_toolkits: connectedToolkits } : {}),
          ...(preferredToolNames.length > 0 ? { preferred_tool_names: preferredToolNames } : {}),
          ...(cursor ? { cursor } : {}),
        },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `MCP tools/list failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
      );
    }
    const parsed = await parseMcpToolsListResponse(res);
    for (const tool of parsed.tools) {
      if (seen.has(tool.name)) {
        continue;
      }
      seen.add(tool.name);
      out.push(tool);
    }
    if (!parsed.nextCursor || parsed.nextCursor === cursor) {
      return out;
    }
    cursor = parsed.nextCursor;
  }
}
