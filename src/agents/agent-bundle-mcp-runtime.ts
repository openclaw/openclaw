/** Session-scoped MCP runtime manager, catalog loader, and transport lifecycle. */
import crypto from "node:crypto";
import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type CallToolResult,
  type ClientCapabilities,
} from "@modelcontextprotocol/sdk/types.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { matchesMcpToolFilterPattern } from "./agent-bundle-mcp-filter.js";
import { assignSafeServerNames, sanitizeServerName } from "./agent-bundle-mcp-names.js";
import type {
  McpCatalogTool,
  McpRequestOptions,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRequesterScope,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import { loadEmbeddedAgentMcpConfig } from "./embedded-agent-mcp.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
import {
  applyMcpConnectionOverride,
  buildMcpRequesterRuntimeCacheKey,
  hashMcpResolvedConnections,
  partitionMcpServersByConnectionScope,
  redactMcpServersForFingerprint,
  resolveMcpConnectionRevalidateMs,
  resolveRequesterScopedMcpConnections,
  type McpServerConnectionResolved,
} from "./mcp-connection-resolver.js";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { sanitizeMcpMetadataText } from "./mcp-metadata.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransport } from "./mcp-transport.js";

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  requestTimeoutMs: number;
  supportsParallelToolCalls: boolean;
  connected: boolean;
  disconnectReason?: string;
  retiring: boolean;
  catalogUseCount: number;
  sharedAcrossCatalogGenerations: boolean;
  connectPromise?: Promise<void>;
  detachStderr?: () => void;
};

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedAgentMcpConfig>;
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type CreateSessionMcpRuntime = (
  params: Parameters<typeof createSessionMcpRuntime>[0] & { configFingerprint?: string },
) => SessionMcpRuntime;

const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
const MCP_APPS_CLIENT_EXTENSION = "io.modelcontextprotocol/ui";
const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
// Bounds live per-sender MCP transports in one session between idle sweeps;
// far above concurrent-run parallelism, so active requesters never evict.
const SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES = 64;
const BUNDLE_MCP_FAILURE_THRESHOLD = 3;
const BUNDLE_MCP_FAILURE_COOLDOWN_MS = 60_000;
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1_500;
const BUNDLE_MCP_DISPOSE_TIMEOUT_MS = 5_000;
const BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY = 6;
let bundleMcpCatalogListTimeoutMs: number | undefined;
const BUNDLE_MCP_TEST_STATE_KEY = Symbol.for("openclaw.bundleMcpTestState");
type BundleMcpTestState = { disposeTimeoutMs?: number };

function getBundleMcpTestState(): BundleMcpTestState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[BUNDLE_MCP_TEST_STATE_KEY] as BundleMcpTestState | undefined;
  if (existing) {
    return existing;
  }
  const state: BundleMcpTestState = {};
  globalStore[BUNDLE_MCP_TEST_STATE_KEY] = state;
  return state;
}

type McpToolSelection = {
  include?: readonly string[];
  exclude?: readonly string[];
};

type McpServerBackoffState = {
  failures: number;
  retryAfterMs?: number;
};

export { createMcpJsonSchemaValidator as createBundleMcpJsonSchemaValidator };

function connectWithTimeout(
  client: Client,
  transport: Transport,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`MCP server connection timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    client.connect(transport).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(toErrorObject(error, "Non-Error rejection"));
      },
    );
  });
}

function redactErrorUrls(error: unknown): string {
  return redactSensitiveUrlLikeString(String(error));
}

async function listAllTools(client: Client, timeoutMs: number) {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? { cursor } : undefined;
    const page = await client.listTools(params, { timeout: timeoutMs });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function isMcpMethodNotFoundError(error: unknown): boolean {
  if (isMcpConfigRecord(error) && error.code === ErrorCode.MethodNotFound) {
    return true;
  }
  const message = String(error);
  return message.includes("-32601") || /method not found/i.test(message);
}

async function listAllToolsBestEffort(params: {
  client: Client;
  timeoutMs: number;
  suppressUnsupported: boolean;
}): Promise<ListedTool[]> {
  try {
    return await listAllTools(params.client, params.timeoutMs);
  } catch (error) {
    if (params.suppressUnsupported && isMcpMethodNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function hasConfiguredMcpRequestTimeout(rawServer: unknown): boolean {
  if (!rawServer || typeof rawServer !== "object") {
    return false;
  }
  const record = rawServer as Record<string, unknown>;
  for (const key of ["requestTimeoutMs", "timeout"]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return true;
    }
  }
  return false;
}

function getCatalogListTimeoutMs(rawServer: unknown, requestTimeoutMs: number): number {
  if (bundleMcpCatalogListTimeoutMs !== undefined) {
    return bundleMcpCatalogListTimeoutMs;
  }
  return hasConfiguredMcpRequestTimeout(rawServer)
    ? requestTimeoutMs
    : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;
}

function setBundleMcpCatalogListTimeoutMsForTest(timeoutMs?: number): void {
  bundleMcpCatalogListTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : undefined;
}

function setBundleMcpDisposeTimeoutMsForTest(timeoutMs?: number): void {
  // Non-isolated test workers can reload this module while a facade still
  // references an older copy. Share the override across those copies.
  getBundleMcpTestState().disposeTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : undefined;
}

function buildMcpClientCapabilities(mcpAppsEnabled: boolean): ClientCapabilities {
  return mcpAppsEnabled
    ? {
        extensions: {
          [MCP_APPS_CLIENT_EXTENSION]: { mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE] },
        },
      }
    : {};
}

function buildMcpClientOptions(mcpAppsEnabled: boolean): ClientOptions {
  return { capabilities: buildMcpClientCapabilities(mcpAppsEnabled) };
}

async function listAllResources(client: Client, timeoutMs: number) {
  const resources: unknown[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? { cursor } : undefined;
    const page = await client.listResources(params, { timeout: timeoutMs });
    resources.push(...page.resources);
    cursor = page.nextCursor;
  } while (cursor);
  return resources;
}

async function listAllPrompts(client: Client, timeoutMs: number) {
  const prompts: unknown[] = [];
  let cursor: string | undefined;
  do {
    const params = cursor ? { cursor } : undefined;
    const page = await client.listPrompts(params, { timeout: timeoutMs });
    prompts.push(...page.prompts);
    cursor = page.nextCursor;
  } while (cursor);
  return prompts;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  return entries.length > 0 ? entries : undefined;
}

function normalizeToolUiVisibility(value: unknown): Array<"app" | "model"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(
    (entry): entry is "app" | "model" => entry === "app" || entry === "model",
  );
  return [...new Set(normalized)].toSorted();
}

function getMcpToolSelection(rawServer: unknown): McpToolSelection {
  if (!isMcpConfigRecord(rawServer) || !isMcpConfigRecord(rawServer.toolFilter)) {
    return {};
  }
  return {
    include: normalizeStringList(rawServer.toolFilter.include),
    exclude: normalizeStringList(rawServer.toolFilter.exclude),
  };
}

function shouldExposeMcpTool(selection: McpToolSelection, toolName: string): boolean {
  const include = selection.include ?? [];
  const exclude = selection.exclude ?? [];
  if (
    include.length > 0 &&
    !include.some((pattern) => matchesMcpToolFilterPattern(pattern, toolName))
  ) {
    return false;
  }
  return !exclude.some((pattern) => matchesMcpToolFilterPattern(pattern, toolName));
}

function summarizeServerCapabilities(capabilities: ServerCapabilities | undefined) {
  return {
    resources: capabilities?.resources
      ? { listChanged: capabilities.resources.listChanged === true }
      : undefined,
    prompts: capabilities?.prompts
      ? { listChanged: capabilities.prompts.listChanged === true }
      : undefined,
    tools: capabilities?.tools
      ? { listChanged: capabilities.tools.listChanged === true }
      : undefined,
  };
}
async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        resolve();
      }, timeoutMs);
      timer.unref?.();
    }).then(() => false),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function disposeSession(session: BundleMcpSession) {
  session.detachStderr?.();
  const timeoutMs = getBundleMcpTestState().disposeTimeoutMs ?? BUNDLE_MCP_DISPOSE_TIMEOUT_MS;
  const closed = await settleWithin(
    (async () => {
      if (session.transportType === "streamable-http") {
        await (session.transport as StreamableHTTPClientTransport)
          .terminateSession()
          .catch(() => {});
      }
      await session.transport.close().catch(() => {});
      await session.client.close().catch(() => {});
    })(),
    timeoutMs,
  );
  if (!closed) {
    // Force-close transport and client so a hung terminateSession() DELETE
    // gets its AbortSignal triggered by teardown. Stdio owns a process group,
    // so force it dead before disposal can report completion.
    const transportClose =
      session.transport instanceof OpenClawStdioClientTransport
        ? session.transport.forceClose()
        : session.transport.close();
    await settleWithin(Promise.allSettled([transportClose, session.client.close()]), timeoutMs);
  }
}

function digestSafeServerNameAssignments(
  safeServerNamesByServer?: ReadonlyMap<string, string>,
): Record<string, string> | undefined {
  if (!safeServerNamesByServer || safeServerNamesByServer.size === 0) {
    return undefined;
  }
  return Object.fromEntries(
    [...safeServerNamesByServer.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
  );
}

function createCatalogFingerprint(params: {
  servers: Record<string, unknown>;
  mcpAppsEnabled: boolean;
  /** Full-set server→safeName map; assignment changes must invalidate all partitions. */
  safeServerNames?: Record<string, string>;
}): string {
  // Session MCP fingerprints only invalidate in-memory runtime catalogs.
  // Algorithm changes can cause one cache miss, but no persisted state migration.
  // Per-user url/headers never enter this hash (see redactMcpServersForFingerprint).
  return crypto.createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

function filterMcpServers<T>(
  mcpServers: Record<string, T>,
  options?: {
    includeServerNames?: ReadonlySet<string>;
    excludeServerNames?: ReadonlySet<string>;
  },
): Record<string, T> {
  if (!options?.includeServerNames && !options?.excludeServerNames) {
    return mcpServers;
  }
  const filtered: Record<string, T> = {};
  for (const [serverName, rawServer] of Object.entries(mcpServers)) {
    if (options.includeServerNames && !options.includeServerNames.has(serverName)) {
      continue;
    }
    if (options.excludeServerNames?.has(serverName)) {
      continue;
    }
    filtered[serverName] = rawServer;
  }
  return filtered;
}

function loadSessionMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  logDiagnostics?: boolean;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  /** Server names whose url/headers must not affect the fingerprint. */
  redactConnectionServerNames?: ReadonlySet<string>;
  /** Full-set safe-name assignments; folded into fingerprint for all partitions. */
  safeServerNamesByServer?: ReadonlyMap<string, string>;
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
} {
  const loaded = loadEmbeddedAgentMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    manifestRegistry: params.manifestRegistry,
  });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  const mcpServers = filterMcpServers(loaded.mcpServers, {
    includeServerNames: params.includeServerNames,
    excludeServerNames: params.excludeServerNames,
  });
  const fingerprintServers = params.redactConnectionServerNames?.size
    ? redactMcpServersForFingerprint(mcpServers, params.redactConnectionServerNames)
    : mcpServers;
  const safeServerNames = digestSafeServerNameAssignments(params.safeServerNamesByServer);
  return {
    loaded: {
      ...loaded,
      mcpServers,
    },
    fingerprint: createCatalogFingerprint({
      servers: fingerprintServers,
      mcpAppsEnabled: params.cfg?.mcp?.apps?.enabled === true,
      ...(safeServerNames ? { safeServerNames } : {}),
    }),
  };
}

/**
 * Loads enabled MCP config metadata for a session without creating runtimes,
 * connecting transports, or issuing MCP tools/list requests.
 */
export function resolveSessionMcpConfigSummary(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): { fingerprint: string; serverNames: string[] } {
  const { loaded, fingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: false,
    manifestRegistry: params.manifestRegistry,
  });
  const serverNames = Object.keys(loaded.mcpServers).toSorted((a, b) => a.localeCompare(b));
  if (serverNames.length === 0) {
    return { fingerprint, serverNames };
  }
  // Mirror getOrCreate: the bare-keyed runtime folds full-set safe names into
  // its fingerprint and excludes requester-scoped servers from its partition.
  // Compare apples-to-apples or tools.effective reports stale-config forever.
  const safeServerNamesByServer = assignSafeServerNames(Object.keys(loaded.mcpServers));
  const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(loaded.mcpServers);
  const { fingerprint: bareRuntimeFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: false,
    manifestRegistry: params.manifestRegistry,
    ...(requesterScopedServerNames.length > 0
      ? { excludeServerNames: new Set(requesterScopedServerNames) }
      : {}),
    safeServerNamesByServer,
  });
  return { fingerprint: bareRuntimeFingerprint, serverNames };
}

function createDisposedError(sessionId: string): Error {
  return new Error(`bundle-mcp runtime disposed for session ${sessionId}`);
}

function resolveSessionMcpRuntimeIdleTtlMs(cfg?: OpenClawConfig): number {
  const raw = cfg?.mcp?.sessionIdleTtlMs;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
}

export function createSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  /**
   * Precomputed name→safeName for the full declared server set. Required for
   * stable tool names when this runtime holds only a subset of servers.
   */
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  /** Resolved per-requester url/headers; never logged/persisted as credentials. */
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  configFingerprint?: string;
}): SessionMcpRuntime {
  const { loaded, fingerprint: computedFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: true,
    manifestRegistry: params.manifestRegistry,
    includeServerNames: params.includeServerNames,
    excludeServerNames: params.excludeServerNames,
    redactConnectionServerNames: params.redactConnectionServerNames,
    safeServerNamesByServer: params.safeServerNamesByServer,
  });
  const configFingerprint = params.configFingerprint ?? computedFingerprint;
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let disposed = false;
  let catalog: McpToolCatalog | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  let catalogInvalidationGeneration = 0;
  const sessions = new Map<string, BundleMcpSession>();
  const serverBackoff = new Map<string, McpServerBackoffState>();
  const recordServerToolFailure = (serverName: string, nowMs: number) => {
    const previous = serverBackoff.get(serverName);
    const failures = (previous?.failures ?? 0) + 1;
    const nextBackoff: McpServerBackoffState = { failures };
    if (failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
      nextBackoff.retryAfterMs = nowMs + BUNDLE_MCP_FAILURE_COOLDOWN_MS;
    }
    serverBackoff.set(serverName, nextBackoff);
  };
  const runGuardedServerRequest = async <T>(
    serverName: string,
    request: () => Promise<T>,
    options?: McpRequestOptions,
  ): Promise<T> => {
    const tracksFailureBackoff = options?.failureBackoff !== "ignore";
    const nowMs = Date.now();
    const backoff = serverBackoff.get(serverName);
    if (tracksFailureBackoff && backoff?.retryAfterMs && nowMs < backoff.retryAfterMs) {
      throw new Error(
        `bundle-mcp server "${serverName}" is paused after repeated tool failures; retry after ${new Date(backoff.retryAfterMs).toISOString()}`,
      );
    }
    try {
      const result = await request();
      if (tracksFailureBackoff) {
        serverBackoff.delete(serverName);
      }
      return result;
    } catch (error) {
      if (tracksFailureBackoff) {
        recordServerToolFailure(serverName, nowMs);
      }
      throw error;
    }
  };
  const failIfDisposed = () => {
    if (disposed) {
      throw createDisposedError(params.sessionId);
    }
  };
  const requireConnectedSession = (serverName: string): BundleMcpSession => {
    const session = sessions.get(serverName);
    if (!session || !session.connected) {
      throw new Error(
        session?.disconnectReason
          ? `bundle-mcp server "${serverName}" is disconnected: ${session.disconnectReason}`
          : `bundle-mcp server "${serverName}" is not connected`,
      );
    }
    return session;
  };
  const ensureSessionConnected = async (
    session: BundleMcpSession,
    connectionTimeoutMs: number,
  ): Promise<void> => {
    if (session.retiring) {
      throw new Error(`bundle-mcp server "${session.serverName}" is retiring`);
    }
    if (session.connected) {
      return;
    }
    session.connectPromise ??= connectWithTimeout(
      session.client,
      session.transport,
      connectionTimeoutMs,
    )
      .then(() => {
        session.connected = true;
      })
      .finally(() => {
        session.connectPromise = undefined;
      });
    await session.connectPromise;
  };
  const retireSessionIfCurrent = async (
    serverName: string,
    session: BundleMcpSession,
  ): Promise<boolean> => {
    if (sessions.get(serverName) !== session) {
      return false;
    }
    session.retiring = true;
    sessions.delete(serverName);
    await disposeSession(session);
    return true;
  };

  const getCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalog) {
      return catalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }
    const catalogGeneration = catalogInvalidationGeneration;
    const inFlight = (async () => {
      if (Object.keys(loaded.mcpServers).length === 0) {
        return {
          version: 1,
          generatedAt: Date.now(),
          servers: {},
          tools: [],
        };
      }

      const servers: Record<string, McpServerCatalog> = {};
      const tools: McpCatalogTool[] = [];
      const diagnostics: McpToolCatalogDiagnostic[] = [];
      // Prefer session-wide precomputed assignments; fall back only for isolated runtimes.
      const safeServerNamesByServer =
        params.safeServerNamesByServer ?? assignSafeServerNames(Object.keys(loaded.mcpServers));
      const usedServerNames = new Set<string>(
        [...safeServerNamesByServer.values()].map((name) => normalizeLowercaseStringOrEmpty(name)),
      );

      try {
        // Safe names come from the full declared set (precomputed), not from who resolved.
        const preparedEntries: Array<{
          serverName: string;
          rawServer: (typeof loaded.mcpServers)[string];
          resolved: NonNullable<ReturnType<typeof resolveMcpTransport>>;
          safeServerName: string;
          launchDescription: string;
        }> = [];
        for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
          failIfDisposed();
          const override = params.connectionOverrides?.get(serverName);
          // Overrides supply per-requester transport only; never write them back to config.
          const transportSource = override
            ? applyMcpConnectionOverride(rawServer, override)
            : rawServer;
          const resolved = resolveMcpTransport(serverName, transportSource, {
            cfg: params.cfg,
            agentDir: params.agentDir,
          });
          if (!resolved) {
            continue;
          }
          const safeServerName =
            safeServerNamesByServer.get(serverName) ??
            sanitizeServerName(serverName, usedServerNames);
          if (safeServerName !== serverName) {
            logWarn(
              `bundle-mcp: server key "${serverName}" registered as "${safeServerName}" for provider-safe tool names.`,
            );
          }
          // Never put per-user resolved URLs into catalog/diagnostics/model text.
          const launchDescription = override
            ? `${serverName}: requester-scoped connection`
            : resolved.description;
          preparedEntries.push({
            serverName,
            rawServer,
            resolved,
            safeServerName,
            launchDescription,
          });
        }

        // Bounded fan-out keeps common 4-5 server setups parallel without letting
        // large configs spawn/connect every MCP transport at once.
        type ServerResult = {
          serverName: string;
          serverEntry: McpServerCatalog | null;
          toolEntries: McpCatalogTool[];
          diagnostics: McpToolCatalogDiagnostic[];
        };

        const tasks = preparedEntries.map(
          ({ serverName, rawServer, resolved, safeServerName, launchDescription }) =>
            async (): Promise<ServerResult> => {
              failIfDisposed();

              let session = sessions.get(serverName);
              while (
                session &&
                !session.retiring &&
                !session.connected &&
                !session.connectPromise
              ) {
                // A closed SDK client cannot reconnect cleanly on the same transport.
                await retireSessionIfCurrent(serverName, session);
                // Retirement yields while closing. Preserve any replacement that a
                // newer catalog generation installed during that await.
                session = sessions.get(serverName);
              }
              if (session?.retiring) {
                session = undefined;
              }
              const reusedSession = Boolean(session);
              if (!session) {
                const client = new Client(
                  {
                    name: "openclaw-bundle-mcp",
                    version: "0.0.0",
                  },
                  {
                    ...buildMcpClientOptions(mcpAppsEnabled),
                    jsonSchemaValidator: createMcpJsonSchemaValidator(),
                    listChanged: {
                      tools: {
                        autoRefresh: false,
                        debounceMs: 0,
                        onChanged: (error) => {
                          if (error) {
                            logWarn(
                              `bundle-mcp: failed to refresh changed tool list for server "${serverName}": ${redactErrorUrls(error)}`,
                            );
                          }
                          catalogInvalidationGeneration += 1;
                          catalog = null;
                          catalogInFlight = undefined;
                        },
                      },
                    },
                  },
                );
                const createdSession: BundleMcpSession = {
                  serverName,
                  client,
                  transport: resolved.transport,
                  transportType: resolved.transportType,
                  requestTimeoutMs: resolved.requestTimeoutMs,
                  supportsParallelToolCalls: resolved.supportsParallelToolCalls,
                  connected: false,
                  retiring: false,
                  catalogUseCount: 0,
                  sharedAcrossCatalogGenerations: false,
                  detachStderr: resolved.detachStderr,
                };
                // The SDK exposes lifecycle hooks as callback properties. A close is
                // terminal for this client/transport pair.
                // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client is not an EventTarget.
                client.onclose = () => {
                  createdSession.connected = false;
                  createdSession.disconnectReason = "mcp transport closed";
                };
                session = createdSession;
                sessions.set(serverName, session);
              }

              if (session.catalogUseCount === 0) {
                session.sharedAcrossCatalogGenerations = false;
              }
              if (reusedSession && session.catalogUseCount > 0) {
                session.sharedAcrossCatalogGenerations = true;
              }
              session.catalogUseCount += 1;
              try {
                failIfDisposed();
                await ensureSessionConnected(session, resolved.connectionTimeoutMs);
                failIfDisposed();
                const capabilities = summarizeServerCapabilities(
                  session.client.getServerCapabilities(),
                );
                const listedTools = await listAllToolsBestEffort({
                  client: session.client,
                  timeoutMs: getCatalogListTimeoutMs(rawServer, resolved.requestTimeoutMs),
                  suppressUnsupported: Boolean(
                    !capabilities.tools && (capabilities.resources || capabilities.prompts),
                  ),
                });
                failIfDisposed();
                const selection = getMcpToolSelection(rawServer);
                const exposedTools = listedTools.filter((tool) =>
                  shouldExposeMcpTool(selection, tool.name.trim()),
                );
                const serverEntry: McpServerCatalog = {
                  serverName,
                  safeServerName,
                  launchSummary: launchDescription,
                  toolCount: exposedTools.length,
                  requestTimeoutMs: resolved.requestTimeoutMs,
                  supportsParallelToolCalls: resolved.supportsParallelToolCalls,
                  ...(capabilities.resources ? { resources: capabilities.resources } : {}),
                  ...(capabilities.prompts ? { prompts: capabilities.prompts } : {}),
                  ...(capabilities.tools
                    ? {
                        tools: {
                          ...capabilities.tools,
                          ...(exposedTools.length !== listedTools.length
                            ? { filteredCount: listedTools.length - exposedTools.length }
                            : {}),
                        },
                      }
                    : {}),
                  ...(selection.include || selection.exclude
                    ? {
                        toolFilter: {
                          ...(selection.include ? { include: [...selection.include] } : {}),
                          ...(selection.exclude ? { exclude: [...selection.exclude] } : {}),
                        },
                      }
                    : {}),
                };
                const toolEntries: McpCatalogTool[] = [];
                for (const tool of exposedTools) {
                  const toolName = tool.name.trim();
                  if (!toolName) {
                    continue;
                  }
                  const { _meta: metadata } = tool;
                  const uiMeta =
                    metadata?.ui && typeof metadata.ui === "object" && !Array.isArray(metadata.ui)
                      ? (metadata.ui as { resourceUri?: unknown; visibility?: unknown })
                      : undefined;
                  const rawResourceUri = uiMeta?.resourceUri ?? metadata?.["ui/resourceUri"];
                  const uiResourceUri =
                    typeof rawResourceUri === "string" && rawResourceUri.startsWith("ui://")
                      ? rawResourceUri
                      : undefined;
                  const uiVisibility = normalizeToolUiVisibility(uiMeta?.visibility);
                  toolEntries.push({
                    serverName,
                    safeServerName,
                    toolName,
                    title: tool.title,
                    description: sanitizeMcpMetadataText(tool.description),
                    inputSchema: tool.inputSchema,
                    fallbackDescription: `Provided by bundle MCP server "${serverName}" (${launchDescription}).`,
                    ...(uiResourceUri ? { uiResourceUri } : {}),
                    ...(uiVisibility ? { uiVisibility } : {}),
                  });
                }
                return {
                  serverName,
                  serverEntry,
                  toolEntries,
                  diagnostics: [] as McpToolCatalogDiagnostic[],
                };
              } catch (error) {
                const message = redactErrorUrls(error);
                if (!disposed) {
                  const action = reusedSession ? "refresh" : "start";
                  logWarn(
                    `bundle-mcp: failed to ${action} server "${serverName}" (${launchDescription}): ${message}`,
                  );
                }
                const diags: McpToolCatalogDiagnostic[] = [
                  {
                    serverName,
                    safeServerName,
                    launchSummary: launchDescription,
                    message,
                  },
                ];
                const sharedWithNewerGeneration =
                  session.sharedAcrossCatalogGenerations || session.catalogUseCount > 1;
                if (!session.connected) {
                  // A close is terminal for every catalog generation sharing this
                  // session. The identity guard preserves any newer replacement.
                  await retireSessionIfCurrent(serverName, session);
                } else if (!reusedSession && !sharedWithNewerGeneration) {
                  // Catalog invalidation can overlap generations; an older failed
                  // generation must not dispose a session a newer one already reused.
                  await retireSessionIfCurrent(serverName, session);
                }
                failIfDisposed();
                return {
                  serverName,
                  serverEntry: null,
                  toolEntries: [],
                  diagnostics: diags,
                } as ServerResult;
              } finally {
                session.catalogUseCount -= 1;
                if (session.catalogUseCount === 0) {
                  session.sharedAcrossCatalogGenerations = false;
                }
              }
            },
        );
        const { results, firstError, hasError } = await runTasksWithConcurrency({
          tasks,
          limit: BUNDLE_MCP_CATALOG_CONNECT_CONCURRENCY,
          errorMode: "continue",
        });
        if (hasError) {
          throw firstError;
        }

        for (const result of results) {
          if (!result) {
            continue;
          }
          const { serverEntry, toolEntries, diagnostics: serverDiags } = result;
          if (serverEntry) {
            servers[result.serverName] = serverEntry;
          }
          tools.push(...toolEntries);
          diagnostics.push(...serverDiags);
        }

        failIfDisposed();
        return {
          version: 1,
          generatedAt: Date.now(),
          servers,
          tools,
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
        };
      } catch (error) {
        await Promise.allSettled(
          Array.from(sessions.values(), (session) => disposeSession(session)),
        );
        sessions.clear();
        throw error;
      }
    })();
    catalogInFlight = inFlight;

    try {
      const nextCatalog = await inFlight;
      failIfDisposed();
      if (catalogInvalidationGeneration === catalogGeneration) {
        catalog = nextCatalog;
      }
      return nextCatalog;
    } finally {
      if (catalogInFlight === inFlight) {
        catalogInFlight = undefined;
      }
    }
  };

  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint,
    ...(params.requesterScope ? { requesterScope: params.requesterScope } : {}),
    // A runtime partition hosts either only static or only requester-scoped servers.
    isRequesterScopedServer: () => params.requesterScope !== undefined,
    mcpAppsEnabled,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease() {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases = Math.max(0, activeLeases - 1);
        // Release is not use: refreshing lastUsedAt here defeats the idle-sweep TTL.
      };
    },
    getCatalog,
    /** Synchronous catalog snapshot only; must not connect transports or issue tools/list. */
    peekCatalog() {
      return catalog;
    },
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(serverName, toolName, input) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () =>
          (await session.client.callTool(
            {
              name: toolName,
              arguments: isMcpConfigRecord(input) ? input : {},
            },
            undefined,
            { timeout: session.requestTimeoutMs },
          )) as CallToolResult,
      );
    },
    async listTools(serverName, requestParams) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(serverName, async () =>
        session.client.listTools(requestParams, { timeout: session.requestTimeoutMs }),
      );
    },
    async listResources(serverName, options) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () => listAllResources(session.client, session.requestTimeoutMs),
        options,
      );
    },
    async readResource(serverName, uri, options) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () =>
          await session.client.readResource({ uri }, { timeout: session.requestTimeoutMs }),
        options,
      );
    },
    async listResourceTemplates(serverName, requestParams) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(serverName, async () =>
        session.client.listResourceTemplates(requestParams, {
          timeout: session.requestTimeoutMs,
        }),
      );
    },
    async listPrompts(serverName) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(serverName, async () =>
        listAllPrompts(session.client, session.requestTimeoutMs),
      );
    },
    async getPrompt(serverName, name, args) {
      failIfDisposed();
      await getCatalog();
      const session = requireConnectedSession(serverName);
      return await runGuardedServerRequest(
        serverName,
        async () =>
          await session.client.getPrompt(
            { name, ...(args ? { arguments: args } : {}) },
            { timeout: session.requestTimeoutMs },
          ),
      );
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      catalog = null;
      catalogInFlight = undefined;
      const sessionsToClose = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(sessionsToClose.map((session) => disposeSession(session)));
    },
  };
}

const COMBINED_SESSION_MCP_RUNTIME = Symbol.for("openclaw.combinedSessionMcpRuntime");

type CombinedSessionMcpRuntime = SessionMcpRuntime & {
  [COMBINED_SESSION_MCP_RUNTIME]: true;
  managedParts: readonly SessionMcpRuntime[];
};

function isCombinedSessionMcpRuntime(
  runtime: SessionMcpRuntime,
): runtime is CombinedSessionMcpRuntime {
  return (runtime as CombinedSessionMcpRuntime)[COMBINED_SESSION_MCP_RUNTIME] !== undefined;
}

function parseRuntimeCacheSessionId(runtimeKey: string): string {
  if (!runtimeKey.startsWith("{")) {
    return runtimeKey;
  }
  try {
    const parsed = JSON.parse(runtimeKey) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" ? parsed.sessionId : runtimeKey;
  } catch {
    return runtimeKey;
  }
}

/**
 * Merge catalogs from static + requester partitions.
 * Safe names are precomputed from the full declared set, so no re-suffix is needed.
 */
function mergeMcpToolCatalogs(catalogs: readonly McpToolCatalog[]): McpToolCatalog {
  const servers: Record<string, McpServerCatalog> = {};
  const tools: McpCatalogTool[] = [];
  const diagnostics: McpToolCatalogDiagnostic[] = [];

  for (const catalog of catalogs) {
    for (const [serverName, server] of Object.entries(catalog.servers).toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      servers[serverName] = server;
    }
    tools.push(...catalog.tools);
    if (catalog.diagnostics) {
      diagnostics.push(...catalog.diagnostics);
    }
  }
  tools.sort((a, b) => {
    const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
    if (serverOrder !== 0) {
      return serverOrder;
    }
    const toolOrder = a.toolName.localeCompare(b.toolName);
    if (toolOrder !== 0) {
      return toolOrder;
    }
    return a.serverName.localeCompare(b.serverName);
  });
  return {
    version: 1,
    generatedAt: Math.max(0, ...catalogs.map((catalog) => catalog.generatedAt)),
    servers,
    tools,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function createCombinedSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  parts: readonly SessionMcpRuntime[];
}): SessionMcpRuntime {
  if (params.parts.length === 1) {
    return params.parts[0]!;
  }
  const parts = params.parts;
  let lastUsedAt = Math.max(...parts.map((part) => part.lastUsedAt));
  let cachedCatalog: McpToolCatalog | null = null;
  let mergedSourceCatalogs: ReadonlyArray<McpToolCatalog> | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  const serverOwner = new Map<string, SessionMcpRuntime>();

  const rememberServerOwners = (catalog: McpToolCatalog, owner: SessionMcpRuntime) => {
    for (const serverName of Object.keys(catalog.servers)) {
      serverOwner.set(serverName, owner);
    }
  };

  // Parts invalidate their own catalogs on tools/list_changed by replacing or
  // clearing the cached object. Identity-compare against what was merged so the
  // facade re-merges instead of serving a stale combined catalog.
  const cachedCatalogIsCurrent = (): boolean =>
    cachedCatalog !== null &&
    mergedSourceCatalogs !== null &&
    parts.every((part, index) => part.peekCatalog() === mergedSourceCatalogs?.[index]);

  const loadCatalog = async (): Promise<McpToolCatalog> => {
    if (cachedCatalog && cachedCatalogIsCurrent()) {
      return cachedCatalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }
    const inFlight = (async () => {
      const catalogs = await Promise.all(parts.map((part) => part.getCatalog()));
      serverOwner.clear();
      for (let index = 0; index < parts.length; index += 1) {
        rememberServerOwners(catalogs[index]!, parts[index]!);
      }
      mergedSourceCatalogs = catalogs;
      cachedCatalog = mergeMcpToolCatalogs(catalogs);
      return cachedCatalog;
    })();
    catalogInFlight = inFlight;
    try {
      return await inFlight;
    } finally {
      if (catalogInFlight === inFlight) {
        catalogInFlight = undefined;
      }
    }
  };

  // Fresh combined facades have an empty owner map until the catalog is loaded.
  // Share one in-flight getCatalog so concurrent tool/resource calls do not fan out.
  const ownerForServer = async (serverName: string): Promise<SessionMcpRuntime> => {
    if (serverOwner.size === 0) {
      await loadCatalog();
    }
    const owner = serverOwner.get(serverName);
    if (owner) {
      return owner;
    }
    throw new Error(`bundle-mcp server "${serverName}" is not connected`);
  };

  const combined: CombinedSessionMcpRuntime = {
    [COMBINED_SESSION_MCP_RUNTIME]: true,
    managedParts: parts,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint: parts.map((part) => part.configFingerprint).join(":"),
    isRequesterScopedServer(serverName) {
      // Owner map is populated by the catalog load that exposed the tool.
      return serverOwner.get(serverName)?.requesterScope !== undefined;
    },
    mcpAppsEnabled: parts.some((part) => part.mcpAppsEnabled === true),
    createdAt: Math.min(...parts.map((part) => part.createdAt)),
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return parts.reduce((sum, part) => sum + (part.activeLeases ?? 0), 0);
    },
    acquireLease() {
      const releases = parts.map((part) => part.acquireLease?.());
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        for (const release of releases) {
          release?.();
        }
      };
    },
    getCatalog: loadCatalog,
    peekCatalog() {
      if (cachedCatalog && cachedCatalogIsCurrent()) {
        return cachedCatalog;
      }
      const peeked = parts.map((part) => part.peekCatalog());
      if (peeked.some((catalog) => catalog === null)) {
        return null;
      }
      return mergeMcpToolCatalogs(peeked as McpToolCatalog[]);
    },
    markUsed() {
      lastUsedAt = Date.now();
      for (const part of parts) {
        part.markUsed();
      }
    },
    async callTool(serverName, toolName, input) {
      return await (await ownerForServer(serverName)).callTool(serverName, toolName, input);
    },
    async listTools(serverName, requestParams) {
      const owner = await ownerForServer(serverName);
      if (!owner.listTools) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listTools`);
      }
      return await owner.listTools(serverName, requestParams);
    },
    async listResources(serverName, options) {
      const owner = await ownerForServer(serverName);
      if (!owner.listResources) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listResources`);
      }
      return await owner.listResources(serverName, options);
    },
    async readResource(serverName, uri, options) {
      const owner = await ownerForServer(serverName);
      if (!owner.readResource) {
        throw new Error(`bundle-mcp server "${serverName}" does not support readResource`);
      }
      return await owner.readResource(serverName, uri, options);
    },
    async listResourceTemplates(serverName, requestParams) {
      const owner = await ownerForServer(serverName);
      if (!owner.listResourceTemplates) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listResourceTemplates`);
      }
      return await owner.listResourceTemplates(serverName, requestParams);
    },
    async listPrompts(serverName) {
      const owner = await ownerForServer(serverName);
      if (!owner.listPrompts) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listPrompts`);
      }
      return await owner.listPrompts(serverName);
    },
    async getPrompt(serverName, name, args) {
      const owner = await ownerForServer(serverName);
      if (!owner.getPrompt) {
        throw new Error(`bundle-mcp server "${serverName}" does not support getPrompt`);
      }
      return await owner.getPrompt(serverName, name, args);
    },
    async dispose() {
      await Promise.allSettled(parts.map((part) => part.dispose()));
    },
  };
  return combined;
}

function createSessionMcpRuntimeManager(
  opts: {
    createRuntime?: CreateSessionMcpRuntime;
    now?: () => number;
    enableIdleSweepTimer?: boolean;
    idleSweepIntervalMs?: number;
    maxIdleRequesterRuntimesPerSession?: number;
  } = {},
): SessionMcpRuntimeManager {
  // Keys are bare sessionId for static runtimes, or requester composite JSON keys.
  const runtimesBySessionId = new Map<string, SessionMcpRuntime>();
  const sessionIdBySessionKey = new Map<string, string>();
  const idleTtlMsBySessionId = new Map<string, number>();
  const deferredRetirementSessionIds = new Set<string>();
  // Manager-side only: connection hash + resolve time. Never stores raw url/headers.
  const connectionMetaByRuntimeKey = new Map<
    string,
    { connectionHash: string; resolvedAt: number }
  >();
  /**
   * Session-stable advertised catalogs for requester-scoped servers.
   * Keyed by sessionId → serverName. Specs must not vary per sender or shared
   * Codex threads rotate (dynamicToolsFingerprint churn).
   */
  const advertisedScopedCatalogBySessionId = new Map<
    string,
    {
      servers: Map<string, McpServerCatalog>;
      toolsByServer: Map<string, McpCatalogTool[]>;
      signaturesByServer: Map<string, string>;
    }
  >();
  /**
   * Per-runtimeKey serialization for requester resolve+install and dispose.
   * Sections never overlap for one key, so a slow resolve cannot clobber a newer install.
   * Entries are removed when their chain drains.
   */
  const requesterWorkChains = new Map<string, Promise<unknown>>();
  const createRuntime = opts.createRuntime ?? createSessionMcpRuntime;
  const now = opts.now ?? Date.now;
  // Static bare-sessionId create dedup only. Requester keys use requesterWorkChains exclusively.
  const createInFlight = new Map<
    string,
    {
      promise: Promise<SessionMcpRuntime>;
      workspaceDir: string;
      agentDir?: string;
      configFingerprint: string;
    }
  >();
  const idleSweepIntervalMs = opts.idleSweepIntervalMs ?? SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS;
  let idleSweepTimer: ReturnType<typeof setInterval> | undefined;
  let idleSweepInFlight: Promise<void> | undefined;

  const forgetSessionKeysForSessionId = (sessionId: string) => {
    for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
      if (mappedSessionId === sessionId) {
        sessionIdBySessionKey.delete(sessionKey);
      }
    }
  };

  const runtimeKeysForSessionId = (sessionId: string): string[] => {
    const keys: string[] = [];
    for (const [runtimeKey, runtime] of runtimesBySessionId.entries()) {
      if (runtime.sessionId === sessionId) {
        keys.push(runtimeKey);
      }
    }
    return keys;
  };

  const totalActiveLeasesForSessionId = (sessionId: string): number => {
    let total = 0;
    for (const runtimeKey of runtimeKeysForSessionId(sessionId)) {
      total += runtimesBySessionId.get(runtimeKey)?.activeLeases ?? 0;
    }
    return total;
  };

  const runExclusiveOnRuntimeKey = <T>(runtimeKey: string, work: () => Promise<T>): Promise<T> => {
    const previous = requesterWorkChains.get(runtimeKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => work());
    const settled: Promise<unknown> = run.then(
      () => undefined,
      () => undefined,
    );
    requesterWorkChains.set(runtimeKey, settled);
    void settled.finally(() => {
      if (requesterWorkChains.get(runtimeKey) === settled) {
        requesterWorkChains.delete(runtimeKey);
      }
    });
    return run;
  };

  const sweepIdleRuntimes = async (): Promise<number> => {
    const nowMs = now();
    const expired: SessionMcpRuntime[] = [];
    for (const [runtimeKey, runtime] of runtimesBySessionId.entries()) {
      const idleTtlMs =
        idleTtlMsBySessionId.get(runtimeKey) ??
        idleTtlMsBySessionId.get(runtime.sessionId) ??
        DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
      if (idleTtlMs <= 0 || (runtime.activeLeases ?? 0) > 0) {
        continue;
      }
      if (nowMs - runtime.lastUsedAt < idleTtlMs) {
        continue;
      }
      runtimesBySessionId.delete(runtimeKey);
      idleTtlMsBySessionId.delete(runtimeKey);
      connectionMetaByRuntimeKey.delete(runtimeKey);
      expired.push(runtime);
    }
    const touchedSessionIds = new Set(expired.map((runtime) => runtime.sessionId));
    for (const sessionId of touchedSessionIds) {
      if (runtimeKeysForSessionId(sessionId).length === 0) {
        deferredRetirementSessionIds.delete(sessionId);
        forgetSessionKeysForSessionId(sessionId);
      }
    }
    await Promise.allSettled(expired.map((runtime) => runtime.dispose()));
    return expired.length;
  };

  const maxIdleRequesterRuntimes =
    opts.maxIdleRequesterRuntimesPerSession ?? SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES;

  /**
   * A busy shared channel can otherwise accumulate one live scoped runtime per
   * sender until the idle TTL fires. Evict LRU zero-lease requester runtimes
   * beyond the cap; leased runtimes and the bare static runtime never evict.
   */
  const enforceRequesterRuntimeCap = async (
    sessionId: string,
    keepRuntimeKey: string,
  ): Promise<void> => {
    const requesterKeys = runtimeKeysForSessionId(sessionId).filter(
      (runtimeKey) => runtimeKey !== sessionId,
    );
    const overflow = requesterKeys.length - maxIdleRequesterRuntimes;
    if (overflow <= 0) {
      return;
    }
    const evictable = requesterKeys
      .filter((runtimeKey) => runtimeKey !== keepRuntimeKey)
      .map((runtimeKey) => ({ runtimeKey, runtime: runtimesBySessionId.get(runtimeKey) }))
      .filter(
        (entry): entry is { runtimeKey: string; runtime: SessionMcpRuntime } =>
          entry.runtime !== undefined && (entry.runtime.activeLeases ?? 0) === 0,
      )
      .toSorted((a, b) => a.runtime.lastUsedAt - b.runtime.lastUsedAt)
      .slice(0, overflow);
    for (const { runtimeKey, runtime } of evictable) {
      // Serialize with in-flight work on that key so eviction cannot clobber a
      // concurrent reuse or install for the same requester.
      await runExclusiveOnRuntimeKey(runtimeKey, async () => {
        const current = runtimesBySessionId.get(runtimeKey);
        if (current !== runtime || (current.activeLeases ?? 0) > 0) {
          return;
        }
        runtimesBySessionId.delete(runtimeKey);
        idleTtlMsBySessionId.delete(runtimeKey);
        connectionMetaByRuntimeKey.delete(runtimeKey);
        await current.dispose();
      });
    }
  };

  const queueIdleSweep = () => {
    if (idleSweepInFlight) {
      return;
    }
    idleSweepInFlight = sweepIdleRuntimes()
      .then(() => undefined)
      .catch((error: unknown) => {
        logWarn(`bundle-mcp: idle runtime sweep failed: ${String(error)}`);
      })
      .finally(() => {
        idleSweepInFlight = undefined;
      });
  };

  const ensureIdleSweepTimer = () => {
    if (opts.enableIdleSweepTimer === false || idleSweepIntervalMs <= 0 || idleSweepTimer) {
      return;
    }
    idleSweepTimer = setInterval(queueIdleSweep, idleSweepIntervalMs);
    idleSweepTimer.unref?.();
  };

  const clearIdleSweepTimer = () => {
    if (!idleSweepTimer) {
      return;
    }
    clearInterval(idleSweepTimer);
    idleSweepTimer = undefined;
  };

  const disposeRuntimeKeyNow = async (runtimeKey: string): Promise<void> => {
    const inFlight = createInFlight.get(runtimeKey);
    createInFlight.delete(runtimeKey);
    let runtime = runtimesBySessionId.get(runtimeKey);
    if (!runtime && inFlight) {
      runtime = await inFlight.promise.catch(() => undefined);
    }
    runtimesBySessionId.delete(runtimeKey);
    idleTtlMsBySessionId.delete(runtimeKey);
    connectionMetaByRuntimeKey.delete(runtimeKey);
    if (runtime) {
      await runtime.dispose();
    }
  };

  const disposeManagedSession = async (sessionId: string): Promise<void> => {
    deferredRetirementSessionIds.delete(sessionId);
    advertisedScopedCatalogBySessionId.delete(sessionId);
    const runtimeKeys = new Set(runtimeKeysForSessionId(sessionId));
    for (const runtimeKey of createInFlight.keys()) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        runtimeKeys.add(runtimeKey);
      }
    }
    for (const runtimeKey of requesterWorkChains.keys()) {
      if (parseRuntimeCacheSessionId(runtimeKey) === sessionId) {
        runtimeKeys.add(runtimeKey);
      }
    }
    // Serialize disposal with in-flight requester work for composite keys.
    await Promise.allSettled(
      [...runtimeKeys].map((runtimeKey) =>
        runtimeKey.startsWith("{")
          ? runExclusiveOnRuntimeKey(runtimeKey, () => disposeRuntimeKeyNow(runtimeKey))
          : disposeRuntimeKeyNow(runtimeKey),
      ),
    );
    forgetSessionKeysForSessionId(sessionId);
  };

  function scopedCatalogToolsSignature(tools: readonly McpCatalogTool[]): string {
    return JSON.stringify(
      tools.map((tool) => [
        tool.serverName,
        tool.safeServerName,
        tool.toolName,
        tool.title ?? "",
        tool.description ?? "",
        tool.fallbackDescription,
        tool.inputSchema,
        tool.uiResourceUri ?? "",
        tool.uiVisibility ?? null,
      ]),
    );
  }

  const rememberAdvertisedScopedCatalog = (sessionId: string, catalog: McpToolCatalog): void => {
    let entry = advertisedScopedCatalogBySessionId.get(sessionId);
    if (!entry) {
      entry = {
        servers: new Map(),
        toolsByServer: new Map(),
        signaturesByServer: new Map(),
      };
      advertisedScopedCatalogBySessionId.set(sessionId, entry);
    }
    const toolsByServerName = new Map<string, McpCatalogTool[]>();
    for (const tool of catalog.tools) {
      const list = toolsByServerName.get(tool.serverName) ?? [];
      list.push(tool);
      toolsByServerName.set(tool.serverName, list);
    }
    for (const [serverName, server] of Object.entries(catalog.servers)) {
      const tools = (toolsByServerName.get(serverName) ?? []).toSorted((a, b) =>
        a.toolName.localeCompare(b.toolName),
      );
      const signature = scopedCatalogToolsSignature(tools);
      // Identity compare: overwrite only when the listed tool surface changes.
      if (entry.signaturesByServer.get(serverName) === signature) {
        continue;
      }
      entry.servers.set(serverName, server);
      entry.toolsByServer.set(serverName, tools);
      entry.signaturesByServer.set(serverName, signature);
    }
  };

  const getAdvertisedScopedCatalog = (sessionId: string): McpToolCatalog | null => {
    const entry = advertisedScopedCatalogBySessionId.get(sessionId);
    if (!entry || entry.servers.size === 0) {
      return null;
    }
    const servers: Record<string, McpServerCatalog> = {};
    const tools: McpCatalogTool[] = [];
    for (const serverName of [...entry.servers.keys()].toSorted((a, b) => a.localeCompare(b))) {
      servers[serverName] = entry.servers.get(serverName)!;
      tools.push(...(entry.toolsByServer.get(serverName) ?? []));
    }
    tools.sort((a, b) => {
      const serverOrder = a.safeServerName.localeCompare(b.safeServerName);
      if (serverOrder !== 0) {
        return serverOrder;
      }
      return a.toolName.localeCompare(b.toolName);
    });
    return {
      version: 1,
      generatedAt: now(),
      servers,
      tools,
    };
  };

  type RuntimeEntryParams = {
    runtimeKey: string;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    idleTtlMs: number;
    includeServerNames?: ReadonlySet<string>;
    excludeServerNames?: ReadonlySet<string>;
    safeServerNamesByServer?: ReadonlyMap<string, string>;
    connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
    redactConnectionServerNames?: ReadonlySet<string>;
    requesterScope?: SessionMcpRequesterScope;
    configFingerprint?: string;
  };

  const matchesStaticReuse = (params: {
    workspaceDir: string;
    agentDir?: string;
    configFingerprint: string;
    candidate: { workspaceDir: string; agentDir?: string; configFingerprint: string };
  }): boolean =>
    params.candidate.workspaceDir === params.workspaceDir &&
    params.candidate.agentDir === params.agentDir &&
    params.candidate.configFingerprint === params.configFingerprint;

  /** Static/session runtime get-or-create (createInFlight dedup for bare keys only). */
  const getOrCreateRuntimeEntry = async (
    params: RuntimeEntryParams,
  ): Promise<SessionMcpRuntime> => {
    const nextFingerprint =
      params.configFingerprint ??
      loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
        includeServerNames: params.includeServerNames,
        excludeServerNames: params.excludeServerNames,
        redactConnectionServerNames: params.redactConnectionServerNames,
        safeServerNamesByServer: params.safeServerNamesByServer,
      }).fingerprint;
    const existing = runtimesBySessionId.get(params.runtimeKey);
    if (existing) {
      if (
        !matchesStaticReuse({
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          configFingerprint: nextFingerprint,
          candidate: existing,
        })
      ) {
        runtimesBySessionId.delete(params.runtimeKey);
        idleTtlMsBySessionId.delete(params.runtimeKey);
        connectionMetaByRuntimeKey.delete(params.runtimeKey);
        await existing.dispose();
      } else {
        deferredRetirementSessionIds.delete(params.sessionId);
        existing.markUsed();
        idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
        return existing;
      }
    }
    const inFlight = createInFlight.get(params.runtimeKey);
    if (inFlight) {
      if (
        matchesStaticReuse({
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          configFingerprint: nextFingerprint,
          candidate: inFlight,
        })
      ) {
        return inFlight.promise;
      }
      createInFlight.delete(params.runtimeKey);
      const staleRuntime = await inFlight.promise.catch(() => undefined);
      runtimesBySessionId.delete(params.runtimeKey);
      idleTtlMsBySessionId.delete(params.runtimeKey);
      connectionMetaByRuntimeKey.delete(params.runtimeKey);
      await staleRuntime?.dispose();
    }
    const created = Promise.resolve(
      createRuntime({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        cfg: params.cfg,
        manifestRegistry: params.manifestRegistry,
        includeServerNames: params.includeServerNames,
        excludeServerNames: params.excludeServerNames,
        safeServerNamesByServer: params.safeServerNamesByServer,
        connectionOverrides: params.connectionOverrides,
        redactConnectionServerNames: params.redactConnectionServerNames,
        requesterScope: params.requesterScope,
        configFingerprint: nextFingerprint,
      }),
    ).then((runtime) => {
      deferredRetirementSessionIds.delete(params.sessionId);
      runtime.markUsed();
      runtimesBySessionId.set(params.runtimeKey, runtime);
      idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
      return runtime;
    });
    createInFlight.set(params.runtimeKey, {
      promise: created,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      configFingerprint: nextFingerprint,
    });
    try {
      return await created;
    } finally {
      createInFlight.delete(params.runtimeKey);
    }
  };

  /**
   * Install or reuse a requester runtime for already-resolved connections.
   * Must run inside runExclusiveOnRuntimeKey for this runtimeKey.
   */
  const installRequesterRuntime = async (params: {
    runtimeKey: string;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    idleTtlMs: number;
    safeServerNamesByServer: ReadonlyMap<string, string>;
    connectionOverrides: Map<string, McpServerConnectionResolved>;
    redactConnectionServerNames: ReadonlySet<string>;
    requesterScope: SessionMcpRequesterScope;
  }): Promise<SessionMcpRuntime> => {
    const resolvedNameSet = new Set(params.connectionOverrides.keys());
    const { fingerprint: resolvedFingerprint } = loadSessionMcpConfig({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      logDiagnostics: false,
      manifestRegistry: params.manifestRegistry,
      includeServerNames: resolvedNameSet,
      redactConnectionServerNames: params.redactConnectionServerNames,
      safeServerNamesByServer: params.safeServerNamesByServer,
    });
    const connectionHash = hashMcpResolvedConnections(params.connectionOverrides);
    const existing = runtimesBySessionId.get(params.runtimeKey);
    const meta = connectionMetaByRuntimeKey.get(params.runtimeKey);
    if (
      existing &&
      meta?.connectionHash === connectionHash &&
      matchesStaticReuse({
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        configFingerprint: resolvedFingerprint,
        candidate: existing,
      })
    ) {
      deferredRetirementSessionIds.delete(params.sessionId);
      existing.markUsed();
      idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
      connectionMetaByRuntimeKey.set(params.runtimeKey, {
        connectionHash,
        resolvedAt: now(),
      });
      return existing;
    }
    if (existing) {
      runtimesBySessionId.delete(params.runtimeKey);
      idleTtlMsBySessionId.delete(params.runtimeKey);
      connectionMetaByRuntimeKey.delete(params.runtimeKey);
      await existing.dispose();
    }
    const runtime = await getOrCreateRuntimeEntry({
      runtimeKey: params.runtimeKey,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      idleTtlMs: params.idleTtlMs,
      includeServerNames: resolvedNameSet,
      safeServerNamesByServer: params.safeServerNamesByServer,
      connectionOverrides: params.connectionOverrides,
      redactConnectionServerNames: params.redactConnectionServerNames,
      requesterScope: params.requesterScope,
      configFingerprint: resolvedFingerprint,
    });
    connectionMetaByRuntimeKey.set(params.runtimeKey, {
      connectionHash,
      resolvedAt: now(),
    });
    return runtime;
  };

  /** Revoke cached scoped runtime (empty re-resolution). Auth boundary: leases do not block. */
  const revokeRequesterRuntime = async (runtimeKey: string): Promise<void> => {
    await disposeRuntimeKeyNow(runtimeKey);
  };

  /**
   * Full requester section for one runtimeKey: reuse / resolve / install / revoke.
   * Always invoked under runExclusiveOnRuntimeKey.
   */
  const resolveAndInstallRequesterRuntime = async (params: {
    runtimeKey: string;
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
    idleTtlMs: number;
    requesterScopedServerNames: readonly string[];
    scopedNameSet: ReadonlySet<string>;
    safeServerNamesByServer: ReadonlyMap<string, string>;
    fullScopedFingerprint: string;
    requesterSenderId: string;
    agentAccountId?: string | null;
    messageChannel?: string | null;
    requesterScope: SessionMcpRequesterScope;
  }): Promise<SessionMcpRuntime | undefined> => {
    const existing = runtimesBySessionId.get(params.runtimeKey);
    const meta = connectionMetaByRuntimeKey.get(params.runtimeKey);
    const revalidateMs = resolveMcpConnectionRevalidateMs();
    // Full-set + within revalidation window: skip resolver I/O.
    // Revocation/rotation takes effect within MCP_CONNECTION_REVALIDATE_MS even for
    // continuously active requesters (markUsed does not extend this clock alone).
    const withinRevalidateWindow = meta !== undefined && now() - meta.resolvedAt < revalidateMs;
    if (
      withinRevalidateWindow &&
      existing &&
      matchesStaticReuse({
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        configFingerprint: params.fullScopedFingerprint,
        candidate: existing,
      })
    ) {
      deferredRetirementSessionIds.delete(params.sessionId);
      existing.markUsed();
      idleTtlMsBySessionId.set(params.runtimeKey, params.idleTtlMs);
      return existing;
    }

    const connectionOverrides = await resolveRequesterScopedMcpConnections({
      serverNames: params.requesterScopedServerNames,
      requesterSenderId: params.requesterSenderId,
      agentAccountId: params.agentAccountId,
      messageChannel: params.messageChannel,
    });
    if (connectionOverrides.size === 0) {
      // Empty re-resolution revokes cached scoped credentials.
      // Leases do not block: this is an authorization boundary.
      if (runtimesBySessionId.has(params.runtimeKey) || createInFlight.has(params.runtimeKey)) {
        await revokeRequesterRuntime(params.runtimeKey);
      }
      return undefined;
    }
    return await installRequesterRuntime({
      runtimeKey: params.runtimeKey,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      cfg: params.cfg,
      manifestRegistry: params.manifestRegistry,
      idleTtlMs: params.idleTtlMs,
      safeServerNamesByServer: params.safeServerNamesByServer,
      connectionOverrides,
      redactConnectionServerNames: params.scopedNameSet,
      requesterScope: params.requesterScope,
    });
  };

  const manager: SessionMcpRuntimeManager = {
    async getOrCreate(params) {
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
      await sweepIdleRuntimes();
      if (idleTtlMs > 0) {
        ensureIdleSweepTimer();
      }
      if (params.sessionKey) {
        sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }

      const fullConfig = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
      });
      // Safe names from the FULL declared set so partial resolution never changes tool names.
      const safeServerNamesByServer = assignSafeServerNames(
        Object.keys(fullConfig.loaded.mcpServers),
      );
      const { staticServers, requesterScopedServerNames } = partitionMcpServersByConnectionScope(
        fullConfig.loaded.mcpServers,
      );
      const hasRequesterScoped = requesterScopedServerNames.length > 0;

      if (!hasRequesterScoped) {
        return await getOrCreateRuntimeEntry({
          runtimeKey: params.sessionId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          safeServerNamesByServer,
        });
      }

      const parts: SessionMcpRuntime[] = [];
      const scopedNameSet = new Set(requesterScopedServerNames);
      let emptyStaticRuntime: SessionMcpRuntime | undefined;
      if (Object.keys(staticServers).length > 0) {
        parts.push(
          await getOrCreateRuntimeEntry({
            runtimeKey: params.sessionId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            idleTtlMs,
            excludeServerNames: scopedNameSet,
            safeServerNamesByServer,
          }),
        );
      } else {
        // Reconcile bare key when every server is requester-scoped.
        emptyStaticRuntime = await getOrCreateRuntimeEntry({
          runtimeKey: params.sessionId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          includeServerNames: new Set(),
          safeServerNamesByServer,
        });
      }

      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      if (requesterSenderId) {
        const requesterScope: SessionMcpRequesterScope = {
          requesterSenderId,
          ...(normalizeOptionalString(params.agentAccountId)
            ? { agentAccountId: normalizeOptionalString(params.agentAccountId) }
            : {}),
          ...(normalizeOptionalString(params.messageChannel)
            ? { messageChannel: normalizeOptionalString(params.messageChannel) }
            : {}),
        };
        const runtimeKey = buildMcpRequesterRuntimeCacheKey({
          sessionId: params.sessionId,
          messageChannel: params.messageChannel,
          agentAccountId: params.agentAccountId,
          requesterSenderId,
        });
        const { fingerprint: fullScopedFingerprint } = loadSessionMcpConfig({
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          logDiagnostics: false,
          manifestRegistry: params.manifestRegistry,
          includeServerNames: scopedNameSet,
          redactConnectionServerNames: scopedNameSet,
          safeServerNamesByServer,
        });
        const scopedRuntime = await runExclusiveOnRuntimeKey(runtimeKey, () =>
          resolveAndInstallRequesterRuntime({
            runtimeKey,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            idleTtlMs,
            requesterScopedServerNames,
            scopedNameSet,
            safeServerNamesByServer,
            fullScopedFingerprint,
            requesterSenderId,
            agentAccountId: params.agentAccountId,
            messageChannel: params.messageChannel,
            requesterScope,
          }),
        );
        if (scopedRuntime) {
          parts.push(scopedRuntime);
        }
        await enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
      }

      if (parts.length === 0) {
        return (
          emptyStaticRuntime ??
          (await getOrCreateRuntimeEntry({
            runtimeKey: params.sessionId,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            workspaceDir: params.workspaceDir,
            agentDir: params.agentDir,
            cfg: params.cfg,
            manifestRegistry: params.manifestRegistry,
            idleTtlMs,
            includeServerNames: new Set(),
            safeServerNamesByServer,
          }))
        );
      }

      return createCombinedSessionMcpRuntime({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        parts,
      });
    },
    async getOrCreateRequesterScoped(params) {
      // Scoped-only path for shared-thread harnesses: never open static transports
      // (those stay harness-native) so we do not double-connect.
      const idleTtlMs = resolveSessionMcpRuntimeIdleTtlMs(params.cfg);
      await sweepIdleRuntimes();
      if (idleTtlMs > 0) {
        ensureIdleSweepTimer();
      }
      if (params.sessionKey) {
        sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      const requesterSenderId = normalizeOptionalString(params.requesterSenderId);
      if (!requesterSenderId) {
        return undefined;
      }
      const fullConfig = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
      });
      const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(
        fullConfig.loaded.mcpServers,
      );
      if (requesterScopedServerNames.length === 0) {
        return undefined;
      }
      const safeServerNamesByServer = assignSafeServerNames(
        Object.keys(fullConfig.loaded.mcpServers),
      );
      const scopedNameSet = new Set(requesterScopedServerNames);
      const requesterScope: SessionMcpRequesterScope = {
        requesterSenderId,
        ...(normalizeOptionalString(params.agentAccountId)
          ? { agentAccountId: normalizeOptionalString(params.agentAccountId) }
          : {}),
        ...(normalizeOptionalString(params.messageChannel)
          ? { messageChannel: normalizeOptionalString(params.messageChannel) }
          : {}),
      };
      const runtimeKey = buildMcpRequesterRuntimeCacheKey({
        sessionId: params.sessionId,
        messageChannel: params.messageChannel,
        agentAccountId: params.agentAccountId,
        requesterSenderId,
      });
      const { fingerprint: fullScopedFingerprint } = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
        manifestRegistry: params.manifestRegistry,
        includeServerNames: scopedNameSet,
        redactConnectionServerNames: scopedNameSet,
        safeServerNamesByServer,
      });
      const scopedRuntime = await runExclusiveOnRuntimeKey(runtimeKey, () =>
        resolveAndInstallRequesterRuntime({
          runtimeKey,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          cfg: params.cfg,
          manifestRegistry: params.manifestRegistry,
          idleTtlMs,
          requesterScopedServerNames,
          scopedNameSet,
          safeServerNamesByServer,
          fullScopedFingerprint,
          requesterSenderId,
          agentAccountId: params.agentAccountId,
          messageChannel: params.messageChannel,
          requesterScope,
        }),
      );
      if (scopedRuntime) {
        await enforceRequesterRuntimeCap(params.sessionId, runtimeKey);
      }
      return scopedRuntime;
    },
    rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog,
    bindSessionKey(sessionKey, sessionId) {
      sessionIdBySessionKey.set(sessionKey, sessionId);
    },
    resolveSessionId(sessionKey) {
      return sessionIdBySessionKey.get(sessionKey);
    },
    peekSession(params) {
      const sessionId =
        params.sessionId ??
        (params.sessionKey ? sessionIdBySessionKey.get(params.sessionKey) : undefined);
      return sessionId ? runtimesBySessionId.get(sessionId) : undefined;
    },
    async disposeSession(sessionId) {
      await disposeManagedSession(sessionId);
    },
    deferRetirement(sessionId) {
      if (runtimeKeysForSessionId(sessionId).length === 0) {
        return false;
      }
      deferredRetirementSessionIds.add(sessionId);
      return true;
    },
    async completeDeferredRetirement(sessionId, runtime) {
      if (!deferredRetirementSessionIds.has(sessionId) || runtime.sessionId !== sessionId) {
        return false;
      }
      if (totalActiveLeasesForSessionId(sessionId) > 0 || (runtime.activeLeases ?? 0) > 0) {
        return false;
      }
      const managed = runtimeKeysForSessionId(sessionId)
        .map((runtimeKey) => runtimesBySessionId.get(runtimeKey))
        .filter((entry): entry is SessionMcpRuntime => Boolean(entry));
      if (managed.length === 0) {
        return false;
      }
      const managedSet = new Set(managed);
      if (isCombinedSessionMcpRuntime(runtime)) {
        if (!runtime.managedParts.every((part) => managedSet.has(part))) {
          return false;
        }
      } else if (!managedSet.has(runtime)) {
        return false;
      }
      await disposeManagedSession(sessionId);
      return true;
    },
    async disposeAll() {
      clearIdleSweepTimer();
      // Drain all requester chains before clearing maps.
      const chains = Array.from(requesterWorkChains.values());
      requesterWorkChains.clear();
      await Promise.allSettled(chains);
      const inFlightRuntimes = Array.from(createInFlight.values());
      createInFlight.clear();
      const runtimes = Array.from(runtimesBySessionId.values());
      runtimesBySessionId.clear();
      sessionIdBySessionKey.clear();
      idleTtlMsBySessionId.clear();
      deferredRetirementSessionIds.clear();
      connectionMetaByRuntimeKey.clear();
      advertisedScopedCatalogBySessionId.clear();
      const lateRuntimes = await Promise.all(
        inFlightRuntimes.map(async ({ promise }) => await promise.catch(() => undefined)),
      );
      const allRuntimes = new Set<SessionMcpRuntime>(runtimes);
      for (const runtime of lateRuntimes) {
        if (runtime) {
          allRuntimes.add(runtime);
        }
      }
      await Promise.allSettled(Array.from(allRuntimes, (runtime) => runtime.dispose()));
    },
    sweepIdleRuntimes,
    listSessionIds() {
      return [
        ...new Set(Array.from(runtimesBySessionId.values(), (runtime) => runtime.sessionId)),
      ].toSorted((a, b) => a.localeCompare(b));
    },
    listRuntimeKeys() {
      return Array.from(runtimesBySessionId.keys()).toSorted((a, b) => a.localeCompare(b));
    },
    totalActiveLeasesForSession(sessionId) {
      return totalActiveLeasesForSessionId(sessionId);
    },
  };
  // Test-only bookkeeping snapshot for drain assertions.
  Object.assign(manager, {
    bookkeepingSizesForTest: () => ({
      runtimes: runtimesBySessionId.size,
      connectionMeta: connectionMetaByRuntimeKey.size,
      createInFlight: createInFlight.size,
      requesterWorkChains: requesterWorkChains.size,
      sessionKeys: sessionIdBySessionKey.size,
      idleTtl: idleTtlMsBySessionId.size,
      deferredRetirement: deferredRetirementSessionIds.size,
      advertisedScopedCatalogs: advertisedScopedCatalogBySessionId.size,
    }),
  });
  return manager;
}

function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}

export async function getOrCreateSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
}): Promise<SessionMcpRuntime> {
  return await getSessionMcpRuntimeManager().getOrCreate(params);
}

/**
 * Requester-scoped MCP runtime only (no static partition).
 * Shared-thread harnesses use this so static MCP stays harness-native.
 */
export async function getOrCreateRequesterScopedMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  requesterSenderId?: string | null;
  agentAccountId?: string | null;
  messageChannel?: string | null;
}): Promise<SessionMcpRuntime | undefined> {
  return await getSessionMcpRuntimeManager().getOrCreateRequesterScoped(params);
}

export function rememberAdvertisedScopedMcpCatalog(
  sessionId: string,
  catalog: McpToolCatalog,
): void {
  getSessionMcpRuntimeManager().rememberAdvertisedScopedCatalog(sessionId, catalog);
}

export function getAdvertisedScopedMcpCatalog(sessionId: string): McpToolCatalog | null {
  return getSessionMcpRuntimeManager().getAdvertisedScopedCatalog(sessionId);
}

/** Looks up an existing session MCP runtime without creating it or connecting transports. */
export function peekSessionMcpRuntime(params: {
  sessionId?: string | null;
  sessionKey?: string | null;
}): SessionMcpRuntime | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  return getSessionMcpRuntimeManager().peekSession({
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  });
}

async function disposeSessionMcpRuntime(sessionId: string): Promise<void> {
  await getSessionMcpRuntimeManager().disposeSession(sessionId);
}

export async function retireSessionMcpRuntime(params: {
  sessionId?: string | null;
  reason: string;
  preserveActiveLeases?: boolean;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return false;
  }
  const manager = getSessionMcpRuntimeManager();
  // Aggregate leases across static + all requester-scoped parts so preserveActiveLeases
  // does not miss a leased scoped runtime while peeking only the bare session key.
  if (params.preserveActiveLeases === true && manager.totalActiveLeasesForSession(sessionId) > 0) {
    manager.deferRetirement(sessionId);
    return true;
  }
  try {
    await disposeSessionMcpRuntime(sessionId);
    return true;
  } catch (error) {
    params.onError?.(error, sessionId, params.reason);
    return false;
  }
}

/** Completes a one-shot retirement after its final run, view, or request lease releases. */
export async function completeDeferredSessionMcpRuntimeRetirement(
  runtime: SessionMcpRuntime,
): Promise<boolean> {
  return await getSessionMcpRuntimeManager().completeDeferredRetirement(runtime.sessionId, runtime);
}

export async function retireSessionMcpRuntimeForSessionKey(params: {
  sessionKey?: string | null;
  reason: string;
  preserveActiveLeases?: boolean;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const sessionId = getSessionMcpRuntimeManager().resolveSessionId(sessionKey);
  return await retireSessionMcpRuntime({
    sessionId,
    reason: params.reason,
    preserveActiveLeases: params.preserveActiveLeases,
    onError: params.onError,
  });
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export const testing = {
  buildMcpClientCapabilities,
  createSessionMcpRuntimeManager,
  async resetSessionMcpRuntimeManager() {
    await disposeAllSessionMcpRuntimes();
    setBundleMcpCatalogListTimeoutMsForTest();
    setBundleMcpDisposeTimeoutMsForTest();
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest();
    resolverTesting.setMcpConnectionResolverTimeoutMsForTest();
    resolverTesting.setMcpConnectionRevalidateMsForTest();
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManager().listSessionIds();
  },
  getCachedRuntimeKeys() {
    return getSessionMcpRuntimeManager().listRuntimeKeys();
  },
  getBookkeepingSizes(manager: SessionMcpRuntimeManager): Record<string, number> {
    const sizes = (
      manager as SessionMcpRuntimeManager & {
        bookkeepingSizesForTest?: () => Record<string, number>;
      }
    ).bookkeepingSizesForTest?.();
    return sizes ?? {};
  },
  setBundleMcpCatalogListTimeoutMsForTest,
  setBundleMcpDisposeTimeoutMsForTest,
  resolveSessionMcpRuntimeIdleTtlMs,
  mergeMcpToolCatalogs,
};
