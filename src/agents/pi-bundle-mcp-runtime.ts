import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
import { resolveMcpTransport } from "./mcp-transport.js";
import { sanitizeServerName } from "./pi-bundle-mcp-names.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./pi-bundle-mcp-types.js";

type BundleMcpSession = {
  serverName: string;
  description: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  detachStderr?: () => void;
};

/**
 * State machine for a server's reconnect lifecycle.
 * States: absent (first time) | inFlight (reconnecting) | healthy (connected) | dead (exhausted)
 * Dead servers become eligible for resurrection after DEAD_RESURRECT_MS.
 */
type ReconnectState = {
  inFlight: Promise<BundleMcpSession> | null;
  dead: boolean;
  deadAt?: number;
};

/**
 * Default retry delays (seconds) for mid-session reconnect after connection loss.
 * 3 retries: 30s → 60s → 120s. Configurable per-server via `retryDelays` in openclaw.json.
 */
const DEFAULT_RECONNECT_RETRY_DELAYS_S = [30, 60, 120];

/**
 * Default retry delays (seconds) for initial startup connection.
 * Kept short — startup failures are usually config errors, not transient outages.
 * Configurable per-server via `startupRetryDelays` in openclaw.json.
 */
const DEFAULT_STARTUP_RETRY_DELAYS_S = [2, 5];

/**
 * How long callTool waits for a reconnect before rejecting the current caller.
 * The reconnect continues in the background; subsequent callers join or complete it.
 */
const CALLER_RECONNECT_WAIT_MS = 10_000;

/**
 * After a server is marked dead, it becomes eligible for a fresh reconnect attempt
 * after this duration. Allows transient outages to self-heal in long-running sessions.
 */
const DEAD_RESURRECT_MS = 5 * 60_000;

type LoadedMcpConfig = ReturnType<typeof loadEmbeddedPiMcpConfig>;
type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");

/**
 * Read per-server retry delays from the raw server config block.
 * Values are in seconds. Example in openclaw.json:
 *   `"retryDelays": [30, 60, 120]`       — mid-session reconnect delays
 *   `"startupRetryDelays": [2, 5]`       — initial startup delays (shorter recommended)
 * Set to `[]` to disable retries for that context.
 * Returns delays in milliseconds for internal use.
 */
function getMcpRetryDelays(rawServer: unknown, context: "startup" | "reconnect"): number[] {
  const defaults =
    context === "startup" ? DEFAULT_STARTUP_RETRY_DELAYS_S : DEFAULT_RECONNECT_RETRY_DELAYS_S;
  if (rawServer && typeof rawServer === "object") {
    const key = context === "startup" ? "startupRetryDelays" : "retryDelays";
    const delays = (rawServer as Record<string, unknown>)[key];
    if (
      Array.isArray(delays) &&
      delays.every((d): d is number => typeof d === "number" && d >= 0)
    ) {
      return delays.map((d) => d * 1000);
    }
  }
  return defaults.map((d) => d * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sleep for a random duration in [0, baseMs).
 * Spreads concurrent reconnect attempts to avoid thundering herd on shared MCP servers.
 */
function jitteredSleep(baseMs: number): Promise<void> {
  return sleep(Math.floor(Math.random() * baseMs));
}

/**
 * Returns true if the error looks like a transport/connection failure warranting a reconnect.
 * Standard JSON-RPC error codes (-32700 to -32600) indicate the server is alive and responded —
 * these are protocol/application errors and should NOT trigger a reconnect.
 */
function isLikelyTransportError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    // Standard JSON-RPC error range: server processed the request; transport is healthy.
    if (typeof code === "number" && code >= -32700 && code <= -32600) {
      return false;
    }
  }
  return true;
}

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
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function redactErrorUrls(error: unknown): string {
  return redactSensitiveUrlLikeString(String(error));
}

async function listAllTools(client: Client) {
  const tools: ListedTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function disposeSession(session: BundleMcpSession) {
  session.detachStderr?.();
  if (session.transportType === "streamable-http") {
    await (session.transport as StreamableHTTPClientTransport).terminateSession().catch(() => {});
  }
  await session.client.close().catch(() => {});
  await session.transport.close().catch(() => {});
}

function createCatalogFingerprint(servers: Record<string, unknown>): string {
  return crypto.createHash("sha1").update(JSON.stringify(servers)).digest("hex");
}

function loadSessionMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  logDiagnostics?: boolean;
}): {
  loaded: LoadedMcpConfig;
  fingerprint: string;
} {
  const loaded = loadEmbeddedPiMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  if (params.logDiagnostics !== false) {
    for (const diagnostic of loaded.diagnostics) {
      logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
    }
  }
  return {
    loaded,
    fingerprint: createCatalogFingerprint(loaded.mcpServers),
  };
}

function createDisposedError(sessionId: string): Error {
  return new Error(`bundle-mcp runtime disposed for session ${sessionId}`);
}

export function createSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): SessionMcpRuntime {
  const { loaded, fingerprint: configFingerprint } = loadSessionMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    logDiagnostics: true,
  });
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let disposed = false;
  let catalog: McpToolCatalog | null = null;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  const sessions = new Map<string, BundleMcpSession>();
  const reconnectStates = new Map<string, ReconnectState>();

  const failIfDisposed = () => {
    if (disposed) {
      throw createDisposedError(params.sessionId);
    }
  };

  /**
   * Create a fresh client+transport and connect. Single attempt; throws on failure.
   * Disposes the session immediately if the runtime was disposed while connecting,
   * preventing transport/stdio process leaks.
   */
  const makeSession = async (serverName: string, rawServer: unknown): Promise<BundleMcpSession> => {
    const resolved = resolveMcpTransport(serverName, rawServer);
    if (!resolved) {
      throw new Error(`bundle-mcp server "${serverName}" transport could not be resolved`);
    }
    const client = new Client({ name: "openclaw-bundle-mcp", version: "0.0.0" }, {});
    const session: BundleMcpSession = {
      serverName,
      description: resolved.description,
      client,
      transport: resolved.transport,
      transportType: resolved.transportType,
      detachStderr: resolved.detachStderr,
    };
    await connectWithTimeout(client, resolved.transport, resolved.connectionTimeoutMs);
    // Guard: dispose() may have been called while we were connecting.
    // Close this session immediately to avoid leaking transports or child processes.
    if (disposed) {
      await disposeSession(session).catch(() => {});
      throw createDisposedError(params.sessionId);
    }
    return session;
  };

  /**
   * Attempt to connect a server, retrying on failure with jittered delays.
   * Logs each attempt. Throws after all retries are exhausted.
   * Jitter spreads concurrent reconnects to avoid thundering herd on shared servers.
   */
  const connectWithRetries = async (
    serverName: string,
    rawServer: unknown,
    retryDelays: number[],
    context: "startup" | "reconnect",
  ): Promise<BundleMcpSession> => {
    const maxAttempts = 1 + retryDelays.length;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const baseMs = retryDelays[attempt - 1];
        logWarn(
          `bundle-mcp [${context}]: "${serverName}" retry ${attempt}/${retryDelays.length} (up to ${baseMs / 1000}s)`,
        );
        await jitteredSleep(baseMs);
        failIfDisposed();
      }
      try {
        const session = await makeSession(serverName, rawServer);
        if (attempt === 0) {
          logInfo(`bundle-mcp [${context}]: "${serverName}" connected`);
        } else {
          logWarn(
            `bundle-mcp [${context}]: "${serverName}" connected after ${attempt} ${attempt === 1 ? "retry" : "retries"}`,
          );
        }
        return session;
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts - 1) {
          logError(
            `bundle-mcp [${context}]: "${serverName}" failed after ${maxAttempts} attempt(s), marking dead: ${redactErrorUrls(error)}`,
          );
        } else {
          logWarn(
            `bundle-mcp [${context}]: "${serverName}" attempt ${attempt + 1}/${maxAttempts} failed: ${redactErrorUrls(error)}`,
          );
        }
      }
    }
    throw lastError;
  };

  /**
   * Reconnect a server that lost its connection mid-session.
   *
   * - Deduplicates: concurrent callers share one in-flight attempt.
   * - Dead servers reject immediately, but become eligible for resurrection after DEAD_RESURRECT_MS.
   * - On success, publishes the new session and clears in-flight state.
   * - On exhausted retries, marks dead with timestamp for resurrection tracking.
   * - If disposed while reconnecting, cleans up the new session immediately.
   */
  const reconnectSession = (serverName: string): Promise<BundleMcpSession> => {
    let state = reconnectStates.get(serverName);

    if (state?.dead) {
      // Allow resurrection after the dead window expires.
      if (state.deadAt != null && Date.now() - state.deadAt > DEAD_RESURRECT_MS) {
        reconnectStates.delete(serverName);
        state = undefined;
      } else {
        return Promise.reject(
          new Error(`bundle-mcp server "${serverName}" is dead (all reconnect attempts exhausted)`),
        );
      }
    }

    if (state?.inFlight) {
      return state.inFlight;
    }

    const rawServer = loaded.mcpServers[serverName];
    if (!rawServer) {
      return Promise.reject(new Error(`bundle-mcp server "${serverName}" config not found`));
    }
    const retryDelays = getMcpRetryDelays(rawServer, "reconnect");

    const attempt = (async () => {
      const existing = sessions.get(serverName);
      if (existing) {
        await disposeSession(existing);
        sessions.delete(serverName);
      }
      try {
        const session = await connectWithRetries(serverName, rawServer, retryDelays, "reconnect");
        // Guard: dispose() may have fired while we were reconnecting.
        if (disposed) {
          await disposeSession(session).catch(() => {});
          reconnectStates.set(serverName, { inFlight: null, dead: false });
          throw createDisposedError(params.sessionId);
        }
        sessions.set(serverName, session);
        reconnectStates.set(serverName, { inFlight: null, dead: false });
        return session;
      } catch (error) {
        if (!disposed) {
          reconnectStates.set(serverName, { inFlight: null, dead: true, deadAt: Date.now() });
        }
        throw error;
      }
    })();

    // Suppress unhandled-rejection if dispose() clears reconnectStates before this settles.
    attempt.catch(() => {});

    reconnectStates.set(serverName, { inFlight: attempt, dead: false });
    return attempt;
  };

  const getCatalog = async (): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalog) {
      return catalog;
    }
    if (catalogInFlight) {
      return catalogInFlight;
    }

    catalogInFlight = (async () => {
      const serverEntries = Object.entries(loaded.mcpServers);
      if (serverEntries.length === 0) {
        return { version: 1, generatedAt: Date.now(), servers: {}, tools: [] };
      }

      // Pre-pass: assign safe names deterministically before parallelising.
      // sanitizeServerName mutates usedServerNames and is order-dependent.
      const usedServerNames = new Set<string>();
      const safeNames = new Map<string, string>();
      for (const [serverName] of serverEntries) {
        const safe = sanitizeServerName(serverName, usedServerNames);
        safeNames.set(serverName, safe);
        if (safe !== serverName) {
          logWarn(
            `bundle-mcp: server key "${serverName}" registered as "${safe}" for provider-safe tool names.`,
          );
        }
      }

      // Parallel connect: all servers connect concurrently so one dead server cannot
      // block others. Each task cleans up its own session on error or dispose.
      const results = await Promise.allSettled(
        serverEntries.map(async ([serverName, rawServer]) => {
          const retryDelays = getMcpRetryDelays(rawServer, "startup");
          const session = await connectWithRetries(serverName, rawServer, retryDelays, "startup");
          // session is connected. Any error from here must dispose it to prevent leaks.
          try {
            failIfDisposed();
            const listedTools = await listAllTools(session.client);
            failIfDisposed();
            return { serverName, session, listedTools };
          } catch (err) {
            await disposeSession(session).catch(() => {});
            throw err;
          }
        }),
      );

      // If disposed during parallel connect, clean up any sessions that did connect.
      if (disposed) {
        await Promise.allSettled(
          results.flatMap((r) =>
            r.status === "fulfilled" ? [disposeSession(r.value.session)] : [],
          ),
        );
        throw createDisposedError(params.sessionId);
      }

      const servers: Record<string, McpServerCatalog> = {};
      const tools: McpCatalogTool[] = [];

      for (let i = 0; i < serverEntries.length; i++) {
        const [serverName] = serverEntries[i];
        const safeServerName = safeNames.get(serverName)!;
        const result = results[i];

        if (result.status === "fulfilled") {
          const { session, listedTools } = result.value;
          sessions.set(serverName, session);
          servers[serverName] = {
            serverName,
            launchSummary: session.description,
            toolCount: listedTools.length,
          };
          for (const tool of listedTools) {
            const toolName = tool.name.trim();
            if (!toolName) {
              continue;
            }
            tools.push({
              serverName,
              safeServerName,
              toolName,
              title: tool.title,
              description: normalizeOptionalString(tool.description),
              inputSchema: tool.inputSchema,
              fallbackDescription: `Provided by bundle MCP server "${serverName}" (${session.description}).`,
            });
          }
        } else {
          // connectWithRetries already logged; mark dead.
          reconnectStates.set(serverName, { inFlight: null, dead: true, deadAt: Date.now() });
        }
      }

      return { version: 1, generatedAt: Date.now(), servers, tools };
    })();

    try {
      const nextCatalog = await catalogInFlight;
      failIfDisposed();
      catalog = nextCatalog;
      return nextCatalog;
    } finally {
      catalogInFlight = undefined;
    }
  };

  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint,
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    getCatalog,
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(serverName, toolName, input) {
      failIfDisposed();
      await getCatalog();
      const session = sessions.get(serverName);
      if (!session) {
        if (reconnectStates.get(serverName)?.dead) {
          throw new Error(
            `bundle-mcp server "${serverName}" is dead (all reconnect attempts exhausted)`,
          );
        }
        throw new Error(`bundle-mcp server "${serverName}" is not connected`);
      }
      const args = isMcpConfigRecord(input) ? input : {};
      try {
        return (await session.client.callTool({
          name: toolName,
          arguments: args,
        })) as CallToolResult;
      } catch (error) {
        // Only reconnect on transport failures. Standard JSON-RPC protocol errors
        // (bad args, unknown tool, etc.) mean the server is alive — don't reconnect.
        if (!isLikelyTransportError(error)) {
          throw error;
        }
        failIfDisposed();
        logWarn(
          `bundle-mcp: tool call failed for "${serverName}", attempting reconnect: ${redactErrorUrls(error)}`,
        );
        // Start (or join) a reconnect, but bound this caller's wait to CALLER_RECONNECT_WAIT_MS
        // so they're not blocked for the full retry window. The reconnect continues in the background
        // and subsequent callTool calls will join or inherit the result.
        const reconnectPromise = reconnectSession(serverName);
        const reconnected = await Promise.race([
          reconnectPromise,
          sleep(CALLER_RECONNECT_WAIT_MS).then((): never => {
            throw new Error(
              `bundle-mcp server "${serverName}" reconnect in progress — retry in a moment`,
              { cause: error },
            );
          }),
        ]);
        return (await reconnected.client.callTool({
          name: toolName,
          arguments: args,
        })) as CallToolResult;
      }
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      catalog = null;
      catalogInFlight = undefined;
      // Clear reconnect state. In-flight reconnects will see disposed=true when they
      // complete and will dispose their own sessions (see makeSession + reconnectSession guards).
      reconnectStates.clear();
      const sessionsToClose = Array.from(sessions.values());
      sessions.clear();
      await Promise.allSettled(sessionsToClose.map(disposeSession));
    },
  };
}

function createSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  const runtimesBySessionId = new Map<string, SessionMcpRuntime>();
  const sessionIdBySessionKey = new Map<string, string>();
  const createInFlight = new Map<
    string,
    {
      promise: Promise<SessionMcpRuntime>;
      workspaceDir: string;
      configFingerprint: string;
    }
  >();

  return {
    async getOrCreate(params) {
      if (params.sessionKey) {
        sessionIdBySessionKey.set(params.sessionKey, params.sessionId);
      }
      const { fingerprint: nextFingerprint } = loadSessionMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
        logDiagnostics: false,
      });
      const existing = runtimesBySessionId.get(params.sessionId);
      if (existing) {
        if (
          existing.workspaceDir !== params.workspaceDir ||
          existing.configFingerprint !== nextFingerprint
        ) {
          runtimesBySessionId.delete(params.sessionId);
          await existing.dispose();
        } else {
          existing.markUsed();
          return existing;
        }
      }
      const inFlight = createInFlight.get(params.sessionId);
      if (inFlight) {
        if (
          inFlight.workspaceDir === params.workspaceDir &&
          inFlight.configFingerprint === nextFingerprint
        ) {
          return inFlight.promise;
        }
        createInFlight.delete(params.sessionId);
        const staleRuntime = await inFlight.promise.catch(() => undefined);
        runtimesBySessionId.delete(params.sessionId);
        await staleRuntime?.dispose();
      }
      const created = Promise.resolve(
        createSessionMcpRuntime({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
        }),
      ).then((runtime) => {
        runtime.markUsed();
        runtimesBySessionId.set(params.sessionId, runtime);
        return runtime;
      });
      createInFlight.set(params.sessionId, {
        promise: created,
        workspaceDir: params.workspaceDir,
        configFingerprint: nextFingerprint,
      });
      try {
        return await created;
      } finally {
        createInFlight.delete(params.sessionId);
      }
    },
    bindSessionKey(sessionKey, sessionId) {
      sessionIdBySessionKey.set(sessionKey, sessionId);
    },
    resolveSessionId(sessionKey) {
      return sessionIdBySessionKey.get(sessionKey);
    },
    async disposeSession(sessionId) {
      const inFlight = createInFlight.get(sessionId);
      createInFlight.delete(sessionId);
      let runtime = runtimesBySessionId.get(sessionId);
      if (!runtime && inFlight) {
        runtime = await inFlight.promise.catch(() => undefined);
      }
      runtimesBySessionId.delete(sessionId);
      if (!runtime) {
        for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
          if (mappedSessionId === sessionId) {
            sessionIdBySessionKey.delete(sessionKey);
          }
        }
        return;
      }
      for (const [sessionKey, mappedSessionId] of sessionIdBySessionKey.entries()) {
        if (mappedSessionId === sessionId) {
          sessionIdBySessionKey.delete(sessionKey);
        }
      }
      await runtime.dispose();
    },
    async disposeAll() {
      const inFlightRuntimes = Array.from(createInFlight.values());
      createInFlight.clear();
      const runtimes = Array.from(runtimesBySessionId.values());
      runtimesBySessionId.clear();
      sessionIdBySessionKey.clear();
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
    listSessionIds() {
      return Array.from(runtimesBySessionId.keys());
    },
  };
}

export function getSessionMcpRuntimeManager(): SessionMcpRuntimeManager {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, createSessionMcpRuntimeManager);
}

export async function getOrCreateSessionMcpRuntime(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): Promise<SessionMcpRuntime> {
  return await getSessionMcpRuntimeManager().getOrCreate(params);
}

export async function disposeSessionMcpRuntime(sessionId: string): Promise<void> {
  await getSessionMcpRuntimeManager().disposeSession(sessionId);
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  await getSessionMcpRuntimeManager().disposeAll();
}

export const __testing = {
  async resetSessionMcpRuntimeManager() {
    await disposeAllSessionMcpRuntimes();
  },
  getCachedSessionIds() {
    return getSessionMcpRuntimeManager().listSessionIds();
  },
};
