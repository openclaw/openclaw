import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  hashMcpResolvedConnections,
  partitionMcpServersByConnectionScope,
} from "./mcp-connection-resolver.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";

type RuntimePart = SessionMcpRuntime & {
  readonly pluginOwned: boolean;
  resetStartupBackoff: () => void;
};

/** Config publication selects parts; each supplied server owner retains its transports. */
export function createSessionMcpRuntimeParts<T extends RuntimePart>(
  params: Parameters<CreateSessionMcpRuntime>[0],
  createServerMcpRuntime: (
    params: Parameters<CreateSessionMcpRuntime>[0] & {
      serverName: string;
      serverConfig: ReturnType<typeof loadSessionMcpConfig>;
    },
  ) => T,
  previous = new Map<string, T>(),
): SessionMcpRuntime {
  const declared = loadSessionMcpConfig({
    ...params,
    includeServerNames: undefined,
    excludeServerNames: undefined,
    logDiagnostics: true,
  });
  const config = loadSessionMcpConfig({
    ...params,
    loaded: declared.loaded,
    safeServerNamesByServer: declared.safeServerNamesByServer,
    logDiagnostics: false,
  });
  const safeNames = declared.safeServerNamesByServer;
  const configForServer = (serverName: string, nextParams = params, loaded = config.loaded) => {
    const connection = nextParams.connectionOverrides?.get(serverName);
    const serverConfig = loadSessionMcpConfig({
      ...nextParams,
      loaded,
      logDiagnostics: false,
      includeServerNames: new Set([serverName]),
      excludeServerNames: undefined,
      safeServerNamesByServer: new Map([[serverName, safeNames.get(serverName)!]]),
      toolOverrides: {
        ...nextParams.toolOverrides,
        mcpToolsDeny: Object.fromEntries(
          Object.entries(nextParams.toolOverrides?.mcpToolsDeny ?? {}).filter(
            ([name]) => name === serverName,
          ),
        ),
      },
    });
    if (connection) {
      serverConfig.fingerprint += `:${hashMcpResolvedConnections(new Map([[serverName, connection]]))}`;
    }
    return serverConfig;
  };
  const owned = new Map<string, T>();
  for (const serverName of Object.keys(config.loaded.mcpServers)) {
    const serverConfig = configForServer(serverName);
    const fingerprint = serverConfig.fingerprint;
    const existing = previous.get(serverName);
    if (
      existing?.configFingerprint === fingerprint &&
      existing.workspaceDir === params.workspaceDir &&
      existing.agentDir === params.agentDir
    ) {
      owned.set(serverName, existing);
      previous.delete(serverName);
    } else {
      owned.set(
        serverName,
        createServerMcpRuntime({
          ...params,
          serverName,
          serverConfig,
          safeServerNamesByServer: safeNames,
          configFingerprint: fingerprint,
        }),
      );
    }
  }
  const requesterConnect = params.requesterConnect;
  const connectFingerprints = new Map(
    Object.keys(requesterConnect?.catalog.servers ?? {}).map((name) => [
      name,
      configForServer(name, params, declared.loaded).fingerprint,
    ]),
  );
  let invalidated = false;
  let pendingDisposal = Promise.resolve();
  let cleanupFailure: PromiseRejectedResult | undefined;
  const disposeParts = (parts: SessionMcpRuntime[]) => {
    // Replacement must join cleanup already started by config publication.
    pendingDisposal = Promise.allSettled([
      pendingDisposal,
      ...parts.map(async (part) => {
        await part.dispose();
        if (!part.joinCleanup) {
          throw new Error("MCP runtime does not expose cleanup ownership");
        }
        await part.joinCleanup();
      }),
    ]).then((results) => {
      cleanupFailure ??= results.find((result) => result.status === "rejected");
    });
    return pendingDisposal;
  };
  const runtime = createCombinedSessionMcpRuntime({
    ...params,
    parts: [...owned.values()],
    // Admitted views keep routing to transferred servers; ownership alone moves.
    serverOwners: new Map(owned),
  });
  runtime.configFingerprint = params.configFingerprint ?? config.fingerprint;
  runtime.requesterScope = params.requesterScope;
  runtime.requesterConnect = requesterConnect && {
    ...requesterConnect,
    get catalog() {
      const catalog = requesterConnect.catalog;
      return {
        ...catalog,
        servers: Object.fromEntries(
          Object.entries(catalog.servers).filter(([name]) => connectFingerprints.has(name)),
        ),
        tools: catalog.tools.filter((tool) => connectFingerprints.has(tool.serverName)),
      };
    },
    createExecute(serverName, options) {
      const execute = requesterConnect.createExecute(serverName, options);
      return (
        execute &&
        (async (...args) => {
          if (!connectFingerprints.has(serverName)) {
            throw new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`);
          }
          return await execute(...args);
        })
      );
    },
  };
  runtime.mcpAppsEnabled = params.cfg?.mcp?.apps?.enabled === true;
  const joinParts = runtime.joinCleanup;
  runtime.joinCleanup = async () => {
    await pendingDisposal;
    try {
      await joinParts?.();
    } catch (error) {
      cleanupFailure ??= { status: "rejected", reason: error };
    }
    if (cleanupFailure) {
      recordAgentCleanupFailure();
      throw cleanupFailure.reason;
    }
  };
  runtime.dispose = async () => {
    connectFingerprints.clear();
    invalidated = true;
    const retired = [...owned.values()];
    owned.clear();
    sessionMcpRuntimeOwners.delete(runtime);
    await disposeParts(retired);
    if (cleanupFailure) {
      recordAgentCleanupFailure();
    }
  };
  sessionMcpRuntimeOwners.set(runtime, {
    hasServers: () => owned.size > 0,
    isCurrent: () => !invalidated,
    replace: (nextParams) =>
      createSessionMcpRuntimeParts(nextParams, createServerMcpRuntime, owned),
    async retireUnusedServers(retainedServerNames) {
      if (invalidated) {
        return;
      }
      const retired: SessionMcpRuntime[] = [];
      for (const [serverName, part] of owned) {
        if (!retainedServerNames.has(serverName) && (part.activeLeases ?? 0) === 0) {
          owned.delete(serverName);
          retired.push(part);
        }
      }
      if (retired.length === 0) {
        return;
      }
      // Reacquisition can discover new members while transferring healthy survivors.
      invalidated = true;
      await disposeParts(retired);
      if (cleanupFailure) {
        recordAgentCleanupFailure();
      }
    },
    async reload({ cfg, manifestRegistry, reloadPlugins }) {
      const nextParams = { ...params, cfg, manifestRegistry };
      const nextConfig = loadSessionMcpConfig({
        ...nextParams,
        includeServerNames: undefined,
        excludeServerNames: undefined,
        safeServerNamesByServer: undefined,
        logDiagnostics: false,
      });
      const nextSafeNames = nextConfig.safeServerNamesByServer;
      const { requesterScopedServerNames } = partitionMcpServersByConnectionScope(
        nextConfig.loaded.mcpServers,
      );
      for (const [name, fingerprint] of connectFingerprints) {
        if (
          (reloadPlugins && !Object.hasOwn(params.cfg?.mcp?.servers ?? {}, name)) ||
          cfg.gateway?.publicOrigin !== params.cfg?.gateway?.publicOrigin ||
          configForServer(name, nextParams, nextConfig.loaded).fingerprint !== fingerprint ||
          nextSafeNames.get(name) !== safeNames.get(name)
        ) {
          invalidated = true;
          connectFingerprints.delete(name);
        }
      }
      const retired: SessionMcpRuntime[] = [];
      for (const [serverName, part] of owned) {
        part.resetStartupBackoff();
        if (
          (reloadPlugins && part.pluginOwned) ||
          !Object.hasOwn(nextConfig.loaded.mcpServers, serverName) ||
          requesterScopedServerNames.includes(serverName) !== Boolean(params.requesterScope) ||
          nextSafeNames.get(serverName) !== safeNames.get(serverName) ||
          configForServer(serverName, nextParams, nextConfig.loaded).fingerprint !==
            part.configFingerprint
        ) {
          invalidated = true;
          owned.delete(serverName);
          retired.push(part);
        }
      }
      // Disposal revokes the changed owner synchronously, before transport cleanup yields.
      await disposeParts(retired);
    },
  });
  return runtime;
}
