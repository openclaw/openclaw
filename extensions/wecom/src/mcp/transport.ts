/**
 * MCP Streamable HTTP Transport Layer Module
 *
 * Responsible for:
 * - MCP JSON-RPC over HTTP communication (sending requests, parsing responses)
 * - Streamable HTTP session lifecycle management (initialize handshake → Mcp-Session-Id maintenance → invalidation rebuild)
 * - Auto-detecting stateless Servers: if initialize response does not return Mcp-Session-Id,
 *   marks as stateless mode, subsequent requests skip handshake and session management
 * - SSE streaming response parsing
 * - MCP config runtime caching (fetching URL via WSClient and caching in memory)
 */

import { generateReqId } from "@wecom/aibot-node-sdk";
import { MCP_GET_CONFIG_CMD, MCP_CONFIG_FETCH_TIMEOUT_MS } from "../const.js";
import { getWeComWebSocket } from "../state-manager.js";
import { withTimeout } from "../timeout.js";
import { PLUGIN_VERSION } from "../version.js";

// ============================================================================
// Type Definitions
// ============================================================================

/** MCP JSON-RPC request body */
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string;
  method: string;
  params?: Record<string, unknown>;
}

/** MCP JSON-RPC response body */
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Streamable HTTP Session Information
 *
 * Each MCP Server category maintains an independent session containing:
 * - sessionId: session identifier returned by server via Mcp-Session-Id response header
 * - initialized: whether the initialize handshake is complete
 * - stateless: marked as stateless mode when server doesn't return Mcp-Session-Id, subsequent requests skip session management
 */
interface McpSession {
  sessionId: string | null;
  initialized: boolean;
  stateless: boolean;
}

// ============================================================================
// Internal State
// ============================================================================

/** HTTP request timeout (milliseconds) */
const HTTP_REQUEST_TIMEOUT_MS = 30_000;

/** Media download request timeout (milliseconds); base64-encoded media files can be up to ~27MB */
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 120_000;

/** Log prefix */
const LOG_TAG = "[mcp]";

/**
 * MCP JSON-RPC Error
 *
 * Carries the JSON-RPC error.code returned by the server,
 * used by upper layers for differentiated handling based on error codes (e.g., triggering cache cleanup for specific codes).
 */
export class McpRpcError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpRpcError";
  }
}

/**
 * MCP HTTP Error
 *
 * Carries HTTP status code for precise detection of session invalidation (404) and similar scenarios,
 * avoiding false positives from string-matching "404".
 */
export class McpHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "McpHttpError";
  }
}

/**
 * Set of JSON-RPC error codes that require cache cleanup
 *
 * When the MCP Server returns these error codes, it indicates server state has changed
 * (e.g., config change, service restart), requiring cleanup of all caches for the
 * corresponding category to ensure the next request re-fetches config and rebuilds the session.
 *
 * - -32001: Server Unavailable
 * - -32002: Config Changed
 * - -32003: Auth Failed
 */
const CACHE_CLEAR_ERROR_CODES = new Set([-32001, -32002, -32003]);

/** MCP config cache: "accountId:category" → response.body (full config) */
const mcpConfigCache = new Map<string, Record<string, unknown>>();

/** Streamable HTTP session cache: "accountId:category" → session */
const mcpSessionCache = new Map<string, McpSession>();

/** Set of confirmed stateless MCP Server keys ("accountId:category") */
const statelessCategories = new Set<string>();

/** In-flight initialize requests (prevents concurrent duplicate initialization), keyed by "accountId:category" */
const inflightInitRequests = new Map<string, Promise<McpSession>>();

/** Build a composite cache key scoped by account and category */
function cacheKey(accountId: string, category: string): string {
  return `${accountId}:${category}`;
}

// ============================================================================
// MCP Config Fetching & Caching
// ============================================================================

/**
 * Fetch the complete MCP config for a specified category via WSClient
 *
 * @param accountId - Account ID used to look up the WSClient
 * @param category - MCP category name, e.g., doc, contact
 * @returns Complete response.body config object (containing at least a url field)
 */
async function fetchMcpConfig(
  accountId: string,
  category: string,
): Promise<Record<string, unknown>> {
  const wsClient = getWeComWebSocket(accountId);
  if (!wsClient) {
    throw new Error(`WSClient not connected for account "${accountId}", cannot fetch MCP config`);
  }

  const reqId = generateReqId("mcp_config");

  const response = await withTimeout(
    wsClient.reply(
      { headers: { req_id: reqId } },
      { biz_type: category, plugin_version: PLUGIN_VERSION },
      MCP_GET_CONFIG_CMD,
    ),
    MCP_CONFIG_FETCH_TIMEOUT_MS,
    `MCP config fetch for "${category}" timed out after ${MCP_CONFIG_FETCH_TIMEOUT_MS}ms`,
  );

  if (response.errcode !== undefined && response.errcode !== 0) {
    const errMsg = `MCP 配置请求失败: errcode=${response.errcode}, errmsg=${response.errmsg ?? "unknown"}`;
    console.error(`${LOG_TAG} ${errMsg}`);
    throw new Error(errMsg);
  }

  const body = response.body as { url?: string } | undefined;
  if (!body?.url) {
    throw new Error(`MCP 配置响应缺少 url 字段 (category="${category}")`);
  }

  console.log(`${LOG_TAG} 配置拉取成功 (category="${category}")`);
  return body as Record<string, unknown>;
}

/**
 * Get the MCP Server URL for a specified category
 *
 * Reads from memory cache first; fetches via WSClient and caches on miss.
 *
 * @param accountId - Account ID
 * @param category - MCP category name
 * @returns MCP Server URL
 */
async function getMcpUrl(accountId: string, category: string): Promise<string> {
  const key = cacheKey(accountId, category);

  // Check memory cache
  const cached = mcpConfigCache.get(key);
  if (cached) {
    return cached.url as string;
  }

  // Cache miss, fetch via WSClient
  const body = await fetchMcpConfig(accountId, category);

  // Write to cache
  mcpConfigCache.set(key, body);

  console.log(`${LOG_TAG} getMcpUrl ${category}: ${String(body.url)}`);

  return body.url as string;
}

// ============================================================================
// HTTP Low-Level Communication
// ============================================================================

/**
 * Send raw HTTP request to MCP Server (low-level method)
 *
 * Automatically includes the Mcp-Session-Id request header (if available),
 * and updates sessionId from the response header.
 */
async function sendRawJsonRpc(
  url: string,
  session: McpSession,
  body: JsonRpcRequest,
  timeoutMs: number = HTTP_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; rpcResult: unknown; newSessionId: string | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  // Streamable HTTP: include session ID
  if (session.sessionId) {
    headers["Mcp-Session-Id"] = session.sessionId;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`MCP 请求超时 (${timeoutMs}ms)`, { cause: err });
    }
    throw new Error(`MCP 网络请求失败: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  // Extract new sessionId from response header (don't modify input directly; let caller decide how to update)
  const newSessionId = response.headers.get("mcp-session-id");

  if (!response.ok) {
    throw new McpHttpError(
      response.status,
      `MCP HTTP 请求失败: ${response.status} ${response.statusText}`,
    );
  }

  // Streamable HTTP: notification responses may have no body (204 or content-length: 0)
  const contentLength = response.headers.get("content-length");
  if (response.status === 204 || contentLength === "0") {
    return { response, rpcResult: undefined, newSessionId };
  }

  const contentType = response.headers.get("content-type") ?? "";

  // Handle SSE streaming response
  if (contentType.includes("text/event-stream")) {
    return { response, rpcResult: await parseSseResponse(response), newSessionId };
  }

  // Plain JSON response — read text first to prevent JSON.parse error on empty content
  const text = await response.text();
  if (!text.trim()) {
    return { response, rpcResult: undefined, newSessionId };
  }

  const rpc = JSON.parse(text) as JsonRpcResponse;
  if (rpc.error) {
    throw new McpRpcError(
      rpc.error.code,
      `MCP 调用错误 [${rpc.error.code}]: ${rpc.error.message}`,
      rpc.error.data,
    );
  }
  return { response, rpcResult: rpc.result, newSessionId };
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Perform Streamable HTTP initialize handshake for a specified URL
 *
 * Sends initialize → receives serverInfo → sends initialized notification.
 * If the server does not return Mcp-Session-Id, marks as stateless mode and skips session management for subsequent requests.
 */
async function initializeSession(url: string, category: string, key: string): Promise<McpSession> {
  const session: McpSession = { sessionId: null, initialized: false, stateless: false };

  console.log(`${LOG_TAG} 开始 initialize 握手 (category="${category}")`);

  // 1. Send initialize request
  const initBody: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: generateReqId("mcp_init"),
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "wecom_mcp", version: "1.0.0" },
    },
  };

  const { newSessionId: initSessionId } = await sendRawJsonRpc(url, session, initBody);

  // Update session with the returned newSessionId (no longer relying on side-effect mutations)
  if (initSessionId) {
    session.sessionId = initSessionId;
  }

  // Check if the server returned Mcp-Session-Id
  // If not, the Server is a stateless implementation and doesn't need session management
  if (!session.sessionId) {
    session.stateless = true;
    session.initialized = true;
    statelessCategories.add(key);
    mcpSessionCache.set(key, session);
    console.log(`${LOG_TAG} 无状态 Server 确认 (category="${category}")`);
    return session;
  }

  // 2. Send initialized notification (JSON-RPC notification has no id field)
  const notifyBody: JsonRpcRequest = {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  };
  // initialized notification doesn't need to wait for response, but Streamable HTTP requires sending via POST
  const { newSessionId: notifySessionId } = await sendRawJsonRpc(url, session, notifyBody);

  // If the initialized notification response also carries a sessionId, use the latest one
  if (notifySessionId) {
    session.sessionId = notifySessionId;
  }

  session.initialized = true;
  mcpSessionCache.set(key, session);
  console.log(
    `${LOG_TAG} 有状态 Session 建立成功 (category="${category}", sessionId="${session.sessionId}")`,
  );
  return session;
}

/**
 * Get or create the MCP session for a specified URL
 *
 * - Confirmed stateless category: return empty session directly, skip handshake
 * - Existing usable stateful session: return cached directly
 * - Other cases: perform initialize handshake, concurrent requests are merged
 */
async function getOrCreateSession(url: string, category: string, key: string): Promise<McpSession> {
  // Confirmed stateless Server, return empty session directly to skip handshake
  if (statelessCategories.has(key)) {
    const cached = mcpSessionCache.get(key);
    if (cached) {
      return cached;
    }
    // First time found cleared (theoretically shouldn't reach here), re-run handshake detection
  }

  const cached = mcpSessionCache.get(key);
  if (cached?.initialized) {
    return cached;
  }

  // Prevent concurrent duplicate initialization
  const inflight = inflightInitRequests.get(key);
  if (inflight) {
    return inflight;
  }

  const promise = initializeSession(url, category, key).finally(() => {
    inflightInitRequests.delete(key);
  });
  inflightInitRequests.set(key, promise);
  return promise;
}

// ============================================================================
// SSE Parsing
// ============================================================================

/**
 * Parse SSE streaming response and extract the final JSON-RPC result
 *
 * Per SSE specification, multiple `data:` lines within the same event are joined with newlines.
 * Empty lines separate different events; the last complete event's data is used.
 */
async function parseSseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const lines = text.split("\n");

  // Parse per SSE spec: empty lines separate events, data lines within same event are joined with newlines
  let currentDataParts: string[] = [];
  let lastEventData = "";

  for (const line of lines) {
    if (line.startsWith("data: ")) {
      currentDataParts.push(line.slice(6));
    } else if (line.startsWith("data:")) {
      // data: with no space after colon means empty string value
      currentDataParts.push(line.slice(5));
    } else if (line.trim() === "" && currentDataParts.length > 0) {
      // Empty line marks end of event, join all data lines
      lastEventData = currentDataParts.join("\n").trim();
      currentDataParts = [];
    }
  }

  // Handle the last event that doesn't end with an empty line
  if (currentDataParts.length > 0) {
    lastEventData = currentDataParts.join("\n").trim();
  }

  if (!lastEventData) {
    throw new Error("SSE 响应中未包含有效数据");
  }

  try {
    const rpc = JSON.parse(lastEventData) as JsonRpcResponse;
    if (rpc.error) {
      throw new McpRpcError(
        rpc.error.code,
        `MCP 调用错误 [${rpc.error.code}]: ${rpc.error.message}`,
        rpc.error.data,
      );
    }
    return rpc.result;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`SSE 响应解析失败: ${lastEventData.slice(0, 200)}`, { cause: err });
    }
    throw err;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Clear all MCP caches for a specified account + category (config, session, stateless flag)
 *
 * Called when MCP Server returns specific error codes to ensure the next request
 * re-fetches config and rebuilds the session.
 *
 * @param accountId - Account ID
 * @param category - MCP category name
 */
export function clearCategoryCache(accountId: string, category: string): void {
  const key = cacheKey(accountId, category);
  console.log(`${LOG_TAG} clearing cache (account="${accountId}", category="${category}")`);
  mcpConfigCache.delete(key);
  mcpSessionCache.delete(key);
  statelessCategories.delete(key);
  inflightInitRequests.delete(key);
}

/** Tool description returned by tools/list */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Optional config for sendJsonRpc */
export interface SendJsonRpcOptions {
  /** Custom HTTP request timeout (milliseconds), defaults to HTTP_REQUEST_TIMEOUT_MS */
  timeoutMs?: number;
}

/**
 * Send JSON-RPC request to MCP Server (Streamable HTTP protocol)
 *
 * Automatically manages session lifecycle:
 * - Stateless Server: skip session management, send request directly
 * - Stateful Server: perform initialize handshake on first call, auto-rebuild and retry on session invalidation (404)
 *
 * @param accountId - Account ID used to look up the WSClient and scope caches
 * @param category - MCP category name
 * @param method - JSON-RPC method name
 * @param params - JSON-RPC parameters
 * @param options - Optional config (e.g., custom timeout)
 * @returns JSON-RPC result
 */
export async function sendJsonRpc(
  accountId: string,
  category: string,
  method: string,
  params?: Record<string, unknown>,
  options?: SendJsonRpcOptions,
): Promise<unknown> {
  const key = cacheKey(accountId, category);
  const url = await getMcpUrl(accountId, category);
  const timeoutMs = options?.timeoutMs;

  const body: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: generateReqId("mcp_rpc"),
    method,
    ...(params !== undefined ? { params } : {}),
  };

  let session = await getOrCreateSession(url, category, key);

  try {
    const { rpcResult, newSessionId } = await sendRawJsonRpc(url, session, body, timeoutMs);
    if (newSessionId) {
      session.sessionId = newSessionId;
    }
    return rpcResult;
  } catch (err) {
    // Specific JSON-RPC error codes trigger cache cleanup (handled uniformly in transport layer; upper layers don't need to care)
    if (err instanceof McpRpcError && CACHE_CLEAR_ERROR_CODES.has(err.code)) {
      clearCategoryCache(accountId, category);
    }

    if (session.stateless) {
      throw err;
    }

    // Stateful Server: session invalidation returns 404; re-initialize and retry once
    if (err instanceof McpHttpError && err.statusCode === 404) {
      console.log(`${LOG_TAG} Session invalidated (category="${category}"), rebuilding...`);
      mcpSessionCache.delete(key);

      session = await rebuildSession(url, category, key);
      const { rpcResult, newSessionId } = await sendRawJsonRpc(url, session, body, timeoutMs);
      if (newSessionId) {
        session.sessionId = newSessionId;
      }
      return rpcResult;
    }

    console.error(
      `${LOG_TAG} RPC request failed (category="${category}", method="${method}"): ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Merge concurrent session rebuild requests
 *
 * Similar to getOrCreateSession, uses inflightInitRequests to prevent
 * multiple concurrent requests from simultaneously encountering 404 and duplicating initialize handshakes.
 */
async function rebuildSession(url: string, category: string, key: string): Promise<McpSession> {
  const inflight = inflightInitRequests.get(key);
  if (inflight) {
    return inflight;
  }

  const promise = initializeSession(url, category, key).finally(() => {
    inflightInitRequests.delete(key);
  });
  inflightInitRequests.set(key, promise);
  return promise;
}
