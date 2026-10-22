import { randomUUID } from "node:crypto";
import {
  Client,
  type Transport,
  type Tool,
  type McpSubscription,
} from "@modelcontextprotocol/client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { logWarn } from "../logger.js";
import {
  projectBundleMcpServerCatalog,
  projectBundleMcpCatalogFailure,
} from "./agent-bundle-mcp-catalog-projection.js";
import {
  getSessionMcpRequestSignal,
  runWithSessionMcpRequestSignal,
  withSessionMcpCallerAuthority,
} from "./agent-bundle-mcp-request-context.js";
import type { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { createSessionMcpRuntimeParts } from "./agent-bundle-mcp-runtime-parts.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpRequestOptions,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import {
  getCatalogListTimeoutMs,
  listAllMcpTools,
  listMcpServerItems,
} from "./mcp-catalog-listing.js";
import { bindMcpClientElicitation, MCP_ELICITATION_TIMEOUT_MS } from "./mcp-client-elicitation.js";
import {
  ensureMcpSessionConnected,
  createMcpRequestLifecycle,
  disposeMcpClient,
  isMcpHttpSessionExpired,
} from "./mcp-client-lifecycle.js";
import { applyMcpConnectionOverride } from "./mcp-connection-resolver.js";
import { isMcpMethodNotFoundError, redactMcpDiagnosticError } from "./mcp-error.js";
import { createMcpJsonSchemaValidator } from "./mcp-json-schema-validator.js";
import { buildMcpClientCapabilities, summarizeServerCapabilities } from "./mcp-metadata.js";
import {
  mcpCallToolResultSchema,
  mcpGetPromptResultSchema,
  mcpListResourceTemplatesResultSchema,
  mcpListToolsResultSchema,
  toLegacyMcpCallToolResult,
  toLegacyMcpGetPromptResult,
  toLegacyMcpListResourceTemplatesResult,
  toLegacyMcpListToolsResult,
} from "./mcp-sdk-compatibility.js";
import {
  connectWithMcpStartupBackoff,
  getMcpStartupBackoff,
  McpStartupBackoffError,
  resetMcpStartupBackoff,
} from "./mcp-startup-backoff.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import type { McpToolCatalogMetadata } from "./mcp-tool-metadata.js";
import { resolveMcpTransport } from "./mcp-transport.js";
import { observeNativeMcpProbe } from "./native-mcp-connect.js";
import { createNativeMcpClientBridge } from "./native-mcp-runtime-client.js";
import {
  acquireNativeMcpServer,
  nativeMcpRuntimeBindings,
  type NativeMcpClientContext,
} from "./native-mcp-runtime.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  requestTimeoutMs: number;
  connected: boolean;
  disconnectReason?: string;
  retiring: boolean;
  connectPromise?: Promise<void>;
  disposePromise?: Promise<void>;
  detachStderr?: () => void;
  toolMetadata?: McpToolCatalogMetadata;
  withElicitation?: ReturnType<typeof bindMcpClientElicitation>;
  nativeBridge?: ReturnType<typeof createNativeMcpClientBridge>;
  nativeSubscription?: McpSubscription;
};

const BUNDLE_MCP_FAILURE_THRESHOLD = 3;
const BUNDLE_MCP_FAILURE_COOLDOWN_MS = 60_000;
const BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS = 5_000;

type McpServerBackoffState = {
  session: BundleMcpSession;
  failures: number;
  retryAfterMs?: number;
};

export { createMcpJsonSchemaValidator as createBundleMcpJsonSchemaValidator };

type ServerMcpRuntime = SessionMcpRuntime & {
  readonly pluginOwned: boolean;
  resetStartupBackoff: () => void;
  readonly nativeContextKey: string | undefined;
  readonly nativeCapabilityContext: object | undefined;
  readonly nativeViewCount: number;
};

export function createSessionMcpRuntime(
  params: Parameters<CreateSessionMcpRuntime>[0],
  previous = new Map<string, ServerMcpRuntime>(),
): SessionMcpRuntime {
  return createSessionMcpRuntimeParts(params, createServerMcpRuntime, previous);
}

function createServerMcpRuntime(
  params: Parameters<CreateSessionMcpRuntime>[0] & {
    serverName: string;
    serverConfig: ReturnType<typeof loadSessionMcpConfig>;
  },
  nativeContext?: NativeMcpClientContext,
): ServerMcpRuntime {
  const { loaded, fingerprint: computedFingerprint } = params.serverConfig;
  const serverName = params.serverName;
  const configFingerprint = params.configFingerprint ?? computedFingerprint;
  const startupKey = JSON.stringify([
    params.workspaceDir,
    params.agentDir,
    params.requesterScope,
    serverName,
    configFingerprint,
    // Run-scoped capability contexts cannot share startup failures with other owners.
    ...(nativeContext ? [randomUUID()] : []),
  ]);
  let startupRetryAfterMs: number | undefined;
  const mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  let activeLeases = 0;
  let retiredCatalog: McpToolCatalog | undefined;
  const lifecycleAbortController = new AbortController();
  let catalog: McpToolCatalog | null = null;
  // Transport health cannot revoke advertised schemas; only a successful list
  // or retirement of this configuration owner replaces them.
  let lastListedCatalog: McpToolCatalog | undefined;
  let catalogRetryAfterMs: number | undefined;
  let catalogInFlight: Promise<McpToolCatalog> | undefined;
  const invalidateCatalog = () => {
    catalog = null;
    catalogRetryAfterMs = undefined;
  };
  const scheduleCatalogServerRetry = (message: string) => {
    const server = lastListedCatalog?.servers[serverName];
    invalidateCatalog();
    if (server) {
      catalog = projectBundleMcpCatalogFailure(lastListedCatalog, {
        serverName,
        safeServerName: server.safeServerName ?? serverName,
        launchSummary: server.launchSummary,
        message,
      });
      catalogRetryAfterMs = Date.now();
    }
  };
  const catalogRetryIsDue = (): boolean =>
    catalogRetryAfterMs !== undefined && Date.now() >= catalogRetryAfterMs;
  let currentSession: BundleMcpSession | undefined;
  const nativeContextKey = nativeContext
    ? stableStringify({ capabilities: nativeContext.capabilities, roots: nativeContext.roots })
    : undefined;
  let nativeViewCount = 0;
  const nativeChildren = new Set<ServerMcpRuntime>();
  let awaitSseRecovery = false;
  let disposal: Promise<void> | undefined;
  let cleanupFailed = false;
  const pendingDisposals = new Set<Promise<void>>();
  const disposeSession = (session: BundleMcpSession): Promise<void> => {
    if (session.disposePromise) {
      return session.disposePromise;
    }
    const closing = disposeMcpClient(session)
      .then((outcome) => {
        if (outcome === "uncertain") {
          cleanupFailed = true;
          recordAgentCleanupFailure();
        }
      })
      .catch((error: unknown) => {
        cleanupFailed = true;
        recordAgentCleanupFailure();
        throw error;
      })
      .finally(() => pendingDisposals.delete(closing));
    session.disposePromise = closing;
    pendingDisposals.add(closing);
    return closing;
  };

  let serverBackoff: McpServerBackoffState | undefined;
  const recordServerToolFailure = (session: BundleMcpSession, nowMs: number) => {
    if (currentSession !== session || session.retiring) {
      return undefined;
    }
    const previous = serverBackoff;
    const failures = (previous?.session === session ? previous.failures : 0) + 1;
    const nextBackoff: McpServerBackoffState = { session, failures };
    if (failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
      nextBackoff.retryAfterMs = nowMs + BUNDLE_MCP_FAILURE_COOLDOWN_MS;
    }
    serverBackoff = nextBackoff;
    return failures;
  };
  const failIfDisposed = () => {
    if (retiredCatalog) {
      throw new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`);
    }
  };
  const requireConnectedSession = (): BundleMcpSession => {
    const session = currentSession;
    // Retained descriptors cannot admit calls before the replacement finishes listing.
    if (!session || !session.connected || !session.toolMetadata) {
      throw new Error(
        session?.disconnectReason
          ? `bundle-mcp server "${serverName}" is disconnected: ${session.disconnectReason}`
          : `bundle-mcp server "${serverName}" is not connected`,
      );
    }
    return session;
  };

  const retireSessionIfCurrent = async (session: BundleMcpSession): Promise<boolean> => {
    if (currentSession !== session) {
      return false;
    }
    session.retiring = true;
    currentSession = undefined;
    session.nativeBridge?.emit({ kind: "closed" });
    await disposeSession(session);
    return true;
  };
  const requests = createMcpRequestLifecycle(MCP_ELICITATION_TIMEOUT_MS);
  const runGuardedServerRequest = async <T>(
    session: BundleMcpSession,
    request: () => Promise<T>,
    options?: McpRequestOptions,
  ): Promise<T> => {
    const requestSignal = getSessionMcpRequestSignal();
    const tracksFailureBackoff = options?.failureBackoff !== "ignore";
    const nowMs = Date.now();
    const backoff = serverBackoff;
    if (
      tracksFailureBackoff &&
      backoff?.session === session &&
      backoff.retryAfterMs &&
      nowMs < backoff.retryAfterMs
    ) {
      throw new Error(
        `bundle-mcp server "${serverName}" is paused after repeated tool failures; retry after ${new Date(backoff.retryAfterMs).toISOString()}`,
      );
    }
    if (backoff && backoff.session !== session) {
      serverBackoff = undefined;
    }
    try {
      const result = await request();
      if (tracksFailureBackoff && serverBackoff?.session === session) {
        serverBackoff = undefined;
      }
      return result;
    } catch (error) {
      // A stateful server uses HTTP 404 to invalidate an expired MCP session.
      // Reinitialize a fresh client, but never replay a possibly mutating call.
      const sessionExpired = isMcpHttpSessionExpired(session, error);
      let recycleReason: "expired HTTP session" | "repeated request timeouts" | undefined;
      if (sessionExpired && !requestSignal?.aborted) {
        recycleReason = "expired HTTP session";
      } else if (tracksFailureBackoff && !requestSignal?.aborted) {
        const failures = recordServerToolFailure(session, nowMs);
        if (requests.didTimeout(error) && failures && failures >= BUNDLE_MCP_FAILURE_THRESHOLD) {
          recycleReason = "repeated request timeouts";
        }
      }
      if (recycleReason) {
        serverBackoff = undefined;
        scheduleCatalogServerRetry(recycleReason);
        const timedOut = recycleReason === "repeated request timeouts";
        logWarn(
          `bundle-mcp: recycling server "${serverName}" after ${timedOut ? "repeated timeouts" : "an expired HTTP session"}`,
        );
        void retireSessionIfCurrent(session).catch((retireError: unknown) => {
          logWarn(
            `bundle-mcp: failed to retire ${timedOut ? "timed-out" : "expired-session"} server "${serverName}": ${redactMcpDiagnosticError(retireError)}`,
          );
        });
      }
      throw error;
    }
  };
  const runGuardedMcpRequest = <T>(
    session: BundleMcpSession,
    request: (signal: AbortSignal, holdForHumanInput: () => () => void) => Promise<T>,
    options?: McpRequestOptions,
  ) =>
    runGuardedServerRequest(
      session,
      () => requests.run(session, withSessionMcpCallerAuthority(request)),
      options,
    );
  const collectServerItems = (session: BundleMcpSession, kind: "prompts" | "resources") =>
    listMcpServerItems(kind, {
      client: session.client,
      timeoutMs: session.requestTimeoutMs,
      signal: lifecycleAbortController.signal,
      callerSignal: getSessionMcpRequestSignal(),
      runRequest: (request, signal) =>
        requests.run(session, withSessionMcpCallerAuthority(request), signal),
    });

  const loadCatalog = async (
    discoveryContext?: NativeMcpClientContext,
  ): Promise<McpToolCatalog> => {
    failIfDisposed();
    if (catalogInFlight) {
      return catalogInFlight;
    }
    const inFlight = (async (): Promise<McpToolCatalog> => {
      const rawServer = loaded.mcpServers[serverName]!;
      const override = params.connectionOverrides?.get(serverName);
      const transportSource = override
        ? applyMcpConnectionOverride(rawServer, override)
        : rawServer;
      const resolveTransport = () =>
        resolveMcpTransport(serverName, transportSource, {
          cfg: params.cfg,
          agentDir: params.agentDir,
          prepareDataDir: loaded.prepareDataDirsByServer?.[serverName]?.dataDir,
          requesterScope: params.requesterScope,
        });
      const resolved = resolveTransport();
      if (!resolved) {
        return { version: 1, generatedAt: Date.now(), servers: {}, tools: [] };
      }
      const safeServerName = params.safeServerNamesByServer?.get(serverName) ?? serverName;
      // Resolved requester URLs are credentials and never enter catalog text.
      const launchDescription = override
        ? `${serverName}: requester-scoped connection`
        : resolved.description;
      failIfDisposed();

      let session = currentSession;
      if (session && !session.connected && !session.connectPromise) {
        // A closed SDK client cannot reconnect cleanly on the same transport.
        await retireSessionIfCurrent(session);
        session = undefined;
      }
      const reusedSession = Boolean(session);
      const schemaValidator = createMcpJsonSchemaValidator();
      const createSession = (
        transport: NonNullable<ReturnType<typeof resolveTransport>>,
        legacy = false,
      ) => {
        const client = new Client(
          {
            name: "openclaw-bundle-mcp",
            version: "0.0.0",
          },
          {
            capabilities: nativeContext?.capabilities ?? buildMcpClientCapabilities(mcpAppsEnabled),
            versionNegotiation: { mode: nativeContext && !legacy ? "auto" : "legacy" },
            ...(nativeContext ? { inputRequired: { autoFulfill: false } } : {}),
            jsonSchemaValidator: schemaValidator,
            ...(nativeContext
              ? {}
              : {
                  listChanged: {
                    tools: {
                      autoRefresh: false,
                      debounceMs: 0,
                      onChanged: (error) => {
                        if (error) {
                          logWarn(
                            `bundle-mcp: failed to refresh changed tool list for server "${serverName}": ${redactMcpDiagnosticError(error)}`,
                          );
                        }
                        invalidateCatalog();
                      },
                    },
                  },
                }),
          },
        );
        const createdSession: BundleMcpSession = {
          serverName,
          client,
          ...(mcpAppsEnabled && !nativeContext
            ? { withElicitation: bindMcpClientElicitation(client) }
            : {}),
          transport: transport.transport,
          transportType: transport.transportType,
          requestTimeoutMs: transport.requestTimeoutMs,
          connected: false,
          retiring: false,
          detachStderr: transport.detachStderr,
        };
        if (nativeContext) {
          createdSession.nativeBridge = createNativeMcpClientBridge({
            client,
            transport: transport.transport,
            transportType: transport.transportType,
            context: nativeContext,
            signal: lifecycleAbortController.signal,
            invalidateCatalog,
            validatorForCall: (name) => createdSession.toolMetadata?.validatorForCall(name),
            retire: async () => {
              if (currentSession === createdSession) {
                invalidateCatalog();
                await retireSessionIfCurrent(createdSession);
              }
            },
            acquireLease: () => {
              runtime.markUsed();
              return runtime.acquireLease!();
            },
            runRequest: (signal, request) =>
              runWithSessionMcpRequestSignal(signal, () =>
                runGuardedServerRequest(createdSession, () =>
                  requests.run(
                    createdSession,
                    (requestSignal, holdForHumanInput) =>
                      request(
                        {
                          signal: requestSignal,
                          // The lifecycle owns active time; the SDK bounds the shared human allowance too.
                          timeout: createdSession.requestTimeoutMs + MCP_ELICITATION_TIMEOUT_MS,
                        },
                        holdForHumanInput,
                      ),
                    signal,
                  ),
                ),
              ),
          });
        }
        // The SDK exposes lifecycle hooks as callback properties. A close is
        // terminal for this client/transport pair.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client is not an EventTarget.
        client.onclose = () => {
          const wasConnected = createdSession.connected;
          createdSession.connected = false;
          createdSession.disconnectReason = "mcp transport closed";
          if (wasConnected) {
            createdSession.nativeBridge?.emit({ kind: "closed" });
          }
          // Only established current sessions invalidate the catalog. Startup closes
          // already belong to catalog loading, and retirement must not start a rebuild.
          if (
            wasConnected &&
            !retiredCatalog &&
            !createdSession.retiring &&
            currentSession === createdSession
          ) {
            awaitSseRecovery ||= createdSession.transportType === "sse";
            scheduleCatalogServerRetry("mcp transport closed");
            logWarn(`bundle-mcp: server "${serverName}" closed; next request reconnects`);
          }
        };
        return createdSession;
      };
      if (!session) {
        session = createSession(resolved);
        currentSession = session;
      }

      try {
        failIfDisposed();
        if (!session.connected) {
          const connect = async (connectingSession: BundleMcpSession) => {
            if (!connectingSession.nativeBridge || !discoveryContext) {
              return ensureMcpSessionConnected(connectingSession, resolved.connectionTimeoutMs);
            }
            const initializing = connectingSession.nativeBridge.bind(discoveryContext);
            try {
              await initializing.initialize(() =>
                ensureMcpSessionConnected(connectingSession, resolved.connectionTimeoutMs),
              );
            } finally {
              await initializing.detach();
            }
          };
          const probe =
            nativeContext && session.transport instanceof OpenClawStdioClientTransport
              ? observeNativeMcpProbe(session.transport)
              : undefined;
          try {
            await connectWithMcpStartupBackoff(
              startupKey,
              lifecycleAbortController.signal,
              async () => {
                try {
                  await connect(session!);
                } catch (error) {
                  if (!probe?.canRestartLegacy(error)) {
                    throw error;
                  }
                  probe.detach();
                  await retireSessionIfCurrent(session!);
                  if (cleanupFailed) {
                    throw new Error("MCP probe cleanup could not confirm closure", {
                      cause: error,
                    });
                  }
                  failIfDisposed();
                  discoveryContext?.assertCurrent();
                  lifecycleAbortController.signal.throwIfAborted();
                  const replacement = resolveTransport();
                  if (!replacement) {
                    throw new Error("MCP projection transport is unavailable", { cause: error });
                  }
                  session = createSession(replacement, true);
                  currentSession = session;
                  await connect(session);
                }
              },
              BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS,
            );
          } finally {
            probe?.detach();
          }
        }
        if (
          session.nativeBridge &&
          session.client.getProtocolEra() === "modern" &&
          !session.nativeSubscription
        ) {
          const subscribedSession = session;
          const subscription = await session.nativeBridge.listenForCatalogChanges(
            session.requestTimeoutMs,
          );
          session.nativeSubscription = subscription;
          void subscription?.closed.then(() => {
            subscribedSession.nativeSubscription = undefined;
            if (!subscribedSession.retiring && !retiredCatalog) {
              invalidateCatalog();
              subscribedSession.nativeBridge?.emit({ kind: "invalidated" });
            }
          });
        }
        startupRetryAfterMs = undefined;
        failIfDisposed();
        const capabilities = summarizeServerCapabilities(session.client.getServerCapabilities());
        let listedTools: Tool[];
        try {
          const list = () =>
            listAllMcpTools(
              session!.client,
              getCatalogListTimeoutMs(rawServer, resolved.requestTimeoutMs),
              lifecycleAbortController.signal,
            );
          if (session.nativeBridge && discoveryContext) {
            const listing = session.nativeBridge.bind(discoveryContext);
            try {
              listedTools = await listing.initialize(list);
            } finally {
              await listing.detach();
            }
          } else {
            listedTools = await list();
          }
        } catch (error) {
          if (
            !capabilities.tools &&
            (capabilities.resources || capabilities.prompts) &&
            isMcpMethodNotFoundError(error)
          ) {
            listedTools = [];
          } else {
            throw error;
          }
        }
        failIfDisposed();
        const projected = projectBundleMcpServerCatalog({
          serverName,
          safeServerName,
          launchDescription,
          rawServer,
          listedTools,
          schemaValidator,
          denialMap: params.toolOverrides?.mcpToolsDeny,
          capabilities,
          serverVersion: session.client.getServerVersion(),
          serverCapabilities: session.client.getServerCapabilities(),
          // Served whole, as Claude's native connection received them.
          instructions: session.client.getInstructions()?.trim() || undefined,
          pluginId: loaded.pluginIdsByServer?.[serverName],
          connection: resolved,
        });
        session.toolMetadata = projected.metadata;
        return projected.catalog;
      } catch (error) {
        const message = redactMcpDiagnosticError(error);
        startupRetryAfterMs =
          error instanceof McpStartupBackoffError ? error.retryAfterMs : undefined;
        if (
          !retiredCatalog &&
          (!(error instanceof McpStartupBackoffError) || error.reportFailure)
        ) {
          const action = reusedSession ? "refresh" : "start";
          logWarn(
            `bundle-mcp: failed to ${action} server "${serverName}" (${launchDescription}): ${message}`,
          );
        }
        if (!session.connected || isMcpHttpSessionExpired(session, error) || !reusedSession) {
          // Closed, expired, or failed startups need a fresh process.
          await retireSessionIfCurrent(session);
        }
        failIfDisposed();
        return projectBundleMcpCatalogFailure(lastListedCatalog, {
          serverName,
          safeServerName,
          launchSummary: launchDescription,
          message,
        });
      }
    })();
    catalogInFlight = inFlight;
    try {
      const nextCatalog = await inFlight;
      failIfDisposed();
      // A list-change notification during this load is best effort; the next
      // notification or explicit refresh replaces the completed inventory.
      catalog = nextCatalog;
      if (!nextCatalog.diagnostics?.length) {
        lastListedCatalog = nextCatalog;
        awaitSseRecovery = false;
      }
      catalogRetryAfterMs = nextCatalog.diagnostics?.length
        ? (startupRetryAfterMs ?? Date.now() + BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS)
        : undefined;
      return nextCatalog;
    } finally {
      catalogInFlight = undefined;
    }
  };

  const getCatalog = async (discoveryContext?: NativeMcpClientContext): Promise<McpToolCatalog> => {
    failIfDisposed();
    // Shared startup failures cannot suppress listing on this session's live connection.
    if (!catalog && !currentSession?.connected) {
      const backoff = getMcpStartupBackoff(
        startupKey,
        lifecycleAbortController.signal,
        BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS,
      );
      if (backoff) {
        catalog = projectBundleMcpCatalogFailure(lastListedCatalog, {
          serverName,
          safeServerName: params.safeServerNamesByServer?.get(serverName) ?? serverName,
          launchSummary: serverName,
          message: backoff.message,
        });
        startupRetryAfterMs = backoff.retryAfterMs;
        catalogRetryAfterMs = backoff.retryAfterMs;
      }
    }
    if (catalog && !catalogRetryIsDue()) {
      return catalog;
    }
    if (!catalog) {
      const retryExitedProcess = currentSession?.transportType === "stdio";
      const loadedCatalog = await loadCatalog(discoveryContext);
      // Recover a previously healthy process once; HTTP list failures retain their diagnostic.
      return retryExitedProcess &&
        loadedCatalog.diagnostics?.length &&
        lastListedCatalog &&
        !currentSession
        ? loadCatalog(discoveryContext)
        : loadedCatalog;
    }

    const staleCatalog = catalog;
    catalogRetryAfterMs = undefined;
    void loadCatalog(discoveryContext).catch(() => {
      if (!retiredCatalog && catalog === staleCatalog && catalogRetryAfterMs === undefined) {
        catalogRetryAfterMs = Date.now() + BUNDLE_MCP_CATALOG_FAILURE_RETRY_MS;
      }
    });
    return staleCatalog;
  };
  const getActiveSession = async (requestedServer: string) => {
    if (requestedServer !== serverName) {
      throw new Error(`bundle-mcp server "${requestedServer}" is not connected`);
    }
    const signal = getSessionMcpRequestSignal();
    signal?.throwIfAborted();
    await racePromiseWithAbortSignal(getCatalog(), signal);
    if (awaitSseRecovery && catalogInFlight) {
      await racePromiseWithAbortSignal(catalogInFlight, signal);
    }
    return requireConnectedSession();
  };

  const runtime: ServerMcpRuntime = {
    get nativeContextKey() {
      return nativeContextKey;
    },
    get nativeCapabilityContext() {
      return nativeContext?.capabilityContext;
    },
    get nativeViewCount() {
      return nativeViewCount;
    },
    resetStartupBackoff() {
      resetMcpStartupBackoff(startupKey);
      if (startupRetryAfterMs !== undefined || (catalogInFlight && !currentSession?.connected)) {
        startupRetryAfterMs = undefined;
        invalidateCatalog();
      }
    },
    // Provenance travels with the transport; a later explicit definition cannot relabel it.
    pluginOwned:
      !Object.hasOwn(params.cfg?.mcp?.servers ?? {}, serverName) ||
      params.connectionOverrides?.has(serverName) === true,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint,
    ...(params.requesterScope ? { requesterScope: params.requesterScope } : {}),
    ...(params.requesterConnect ? { requesterConnect: params.requesterConnect } : {}),
    // A runtime partition hosts either only static or only requester-scoped servers.
    isRequesterScopedServer: () => params.requesterScope !== undefined,
    canReadLocalFiles: (name) =>
      name === serverName &&
      currentSession?.connected === true &&
      currentSession.transportType === "stdio",
    mcpAppsEnabled,
    createdAt,
    get lastUsedAt() {
      return Math.max(lastUsedAt, ...[...nativeChildren].map((child) => child.lastUsedAt));
    },
    get activeLeases() {
      return (
        activeLeases +
        [...nativeChildren].reduce((sum, child) => sum + (child.activeLeases ?? 0), 0)
      );
    },
    acquireLease() {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases -= 1;
        // Release is not use: refreshing lastUsedAt here defeats the idle-sweep TTL.
      };
    },
    getCatalog,
    get retiredCatalog() {
      return retiredCatalog;
    },
    /** Synchronous catalog snapshot only; must not connect transports or issue tools/list. */
    peekCatalog() {
      return catalog;
    },
    /** Session-owned timeout that survives catalog invalidation. */
    getServerRequestTimeoutMs(requestedServer: string) {
      return requestedServer === serverName ? currentSession?.requestTimeoutMs : undefined;
    },
    markUsed() {
      lastUsedAt = Date.now();
    },
    async callTool(requestedServer, toolName, input, options) {
      const session = await getActiveSession(requestedServer);
      const validateResult = session.toolMetadata?.validatorForCall(toolName);
      const result = await runGuardedMcpRequest(session, (signal, holdForHumanInput) => {
        options?.assertCurrent?.();
        const call = () =>
          withGuardedFetchRequestAuthority(options?.assertCurrent, () =>
            session.client.request(
              {
                method: "tools/call",
                params: {
                  name: toolName,
                  arguments: isRecord(input) ? input : {},
                  ...(options?._meta ? { _meta: options._meta } : {}),
                },
              },
              mcpCallToolResultSchema,
              {
                // The local deadline owns active work; the SDK bounds the total
                // call, including one shared allowance for pending human input.
                timeout:
                  session.requestTimeoutMs +
                  (session.withElicitation ? MCP_ELICITATION_TIMEOUT_MS : 0),
                signal,
              },
            ),
          );
        return session.withElicitation
          ? session.withElicitation(signal, call, holdForHumanInput)
          : call();
      });
      validateResult?.(result);
      return toLegacyMcpCallToolResult(result);
    },
    async listTools(requestedServer, requestParams) {
      const session = await getActiveSession(requestedServer);
      return toLegacyMcpListToolsResult(
        await runGuardedMcpRequest(session, (signal) =>
          session.client.request(
            { method: "tools/list", params: requestParams },
            mcpListToolsResultSchema,
            { timeout: session.requestTimeoutMs, signal },
          ),
        ),
      );
    },
    async listResources(requestedServer, options) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedServerRequest(
        session,
        async () => collectServerItems(session, "resources"),
        options,
      );
    },
    async readResource(requestedServer, uri, options) {
      const session = await getActiveSession(requestedServer);
      return await runGuardedMcpRequest(
        session,
        (signal) =>
          session.client.request(
            {
              method: "resources/read",
              params: { uri, ...(options?._meta ? { _meta: options._meta } : {}) },
            },
            { timeout: session.requestTimeoutMs, signal },
          ),
        options,
      );
    },
    async listResourceTemplates(requestedServer, requestParams) {
      const session = await getActiveSession(requestedServer);
      return toLegacyMcpListResourceTemplatesResult(
        await runGuardedMcpRequest(session, (signal) =>
          session.client.request(
            { method: "resources/templates/list", params: requestParams },
            mcpListResourceTemplatesResultSchema,
            {
              timeout: session.requestTimeoutMs,
              signal,
            },
          ),
        ),
      );
    },
    async listPrompts(requestedServer) {
      const session = await getActiveSession(requestedServer);
      return runGuardedServerRequest(session, () => collectServerItems(session, "prompts"));
    },
    async getPrompt(requestedServer, name, args) {
      const session = await getActiveSession(requestedServer);
      return toLegacyMcpGetPromptResult(
        await runGuardedMcpRequest(session, (signal) =>
          session.client.request(
            { method: "prompts/get", params: { name, ...(args ? { arguments: args } : {}) } },
            mcpGetPromptResultSchema,
            { timeout: session.requestTimeoutMs, signal },
          ),
        ),
      );
    },
    async joinCleanup() {
      await disposal;
      await Promise.allSettled(pendingDisposals);
      if (cleanupFailed) {
        recordAgentCleanupFailure();
        throw new Error("MCP runtime cleanup could not confirm closure");
      }
    },
    dispose() {
      if (!disposal) {
        retiredCatalog = {
          version: 1,
          generatedAt: Date.now(),
          servers: {},
          tools: [],
          diagnostics: [
            {
              serverName,
              safeServerName: params.safeServerNamesByServer?.get(serverName) ?? serverName,
              launchSummary: serverName,
              message: "MCP server runtime retired; retry discovery on the next turn.",
            },
          ],
        };
        currentSession?.nativeBridge?.emit({ kind: "closed" });
        if (nativeContext) {
          resetMcpStartupBackoff(startupKey);
        }
        lifecycleAbortController.abort(
          new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`),
        );
        catalog = null;
        lastListedCatalog = undefined;
        catalogRetryAfterMs = undefined;
        const pendingCatalog = catalogInFlight;
        catalogInFlight = undefined;
        const session = currentSession;
        currentSession = undefined;
        const children = [...nativeChildren];
        nativeChildren.clear();
        disposal = (async () => {
          const childOutcomes = Promise.allSettled(
            children.map(async (child) => {
              await child.dispose();
              await child.joinCleanup?.();
            }),
          );
          if (session) {
            await disposeSession(session).catch(() => undefined);
          }
          await pendingCatalog?.catch(() => undefined);
          await Promise.allSettled(pendingDisposals);
          if ((await childOutcomes).some((outcome) => outcome.status === "rejected")) {
            cleanupFailed = true;
          }
        })();
      }
      // Physical cleanup is single-flight; uncertainty belongs to every caller.
      void disposal.then(() => {
        if (cleanupFailed) {
          recordAgentCleanupFailure();
        }
      });
      return disposal;
    },
  };
  nativeMcpRuntimeBindings.set(runtime, {
    hasServer: (name) => name === serverName,
    async acquire(name, context) {
      failIfDisposed();
      context.assertCurrent();
      if (name !== serverName) {
        throw new Error(`MCP server "${name}" has no projection owner`);
      }
      if (context.capabilities.elicitation && !context.elicit) {
        throw new Error("MCP elicitation capability requires a handler");
      }
      if (context.capabilities.sampling && !context.createMessage) {
        throw new Error("MCP sampling capability requires a handler");
      }
      if (context.capabilities.extensions?.["openai/elicitation"] && !context.elicitCustom) {
        throw new Error("MCP custom elicitation capability requires a handler");
      }
      const key = stableStringify({ capabilities: context.capabilities, roots: context.roots });
      // Ordinary callers retain their legacy context in either acquisition order.
      if (
        !nativeContext ||
        nativeContextKey !== key ||
        nativeContext.capabilityContext !== context.capabilityContext
      ) {
        let child = [...nativeChildren].find(
          (candidate) =>
            candidate.nativeContextKey === key &&
            candidate.nativeCapabilityContext === context.capabilityContext,
        );
        if (!child) {
          child = createServerMcpRuntime(params, context);
          nativeChildren.add(child);
        }
        const selected = child;
        const cleanupUnused = async () => {
          if (selected.nativeViewCount === 0) {
            lastUsedAt = Math.max(lastUsedAt, selected.lastUsedAt);
            try {
              await selected.dispose();
              await selected.joinCleanup?.();
              nativeChildren.delete(selected);
            } catch (error) {
              cleanupFailed = true;
              recordAgentCleanupFailure();
              throw error;
            }
          }
        };
        try {
          const view = await acquireNativeMcpServer(selected, name, context);
          let releasePromise: Promise<void> | undefined;
          return {
            ...view,
            release() {
              return (releasePromise ??= (async () => {
                try {
                  await view.release();
                } finally {
                  await cleanupUnused();
                }
              })());
            },
          };
        } catch (error) {
          await cleanupUnused();
          throw error;
        }
      }
      nativeViewCount += 1;
      const releaseLease = runtime.acquireLease!();
      let releasePromise: Promise<void> | undefined;
      try {
        // Shared owners can outlive their first borrower; discovery uses this acquisition.
        await getCatalog(context);
        if (catalogInFlight) {
          await catalogInFlight;
        }
        failIfDisposed();
        context.assertCurrent();
        const session = requireConnectedSession();
        if (!session.nativeBridge) {
          throw new Error("MCP session has no projection binding");
        }
        const bound = session.nativeBridge.bind({
          ...context,
          assertCurrent() {
            failIfDisposed();
            context.assertCurrent();
            if (session !== currentSession || !session.connected) {
              throw new Error("MCP projection connection retired");
            }
          },
        });
        return {
          runtime,
          ...bound.protocol,
          release() {
            return (releasePromise ??= (async () => {
              try {
                await bound.detach();
              } finally {
                nativeViewCount -= 1;
              }
            })());
          },
        };
      } catch (error) {
        nativeViewCount -= 1;
        throw error;
      } finally {
        releaseLease();
      }
    },
  });
  return runtime;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
