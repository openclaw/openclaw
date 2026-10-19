import { compareMcpCatalogTools, mcpCatalogToolsSignature } from "./agent-bundle-mcp-names.js";
import { sessionMcpRuntimeOwners } from "./agent-bundle-mcp-runtime-owner.js";
import { SESSION_MCP_MAX_LIVE_RUNTIMES } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  RequesterScopedMcpRuntimeHandle,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

export type SessionMcpCatalogBinding = {
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
  workspaceDir: string;
  agentDir?: string;
  configFingerprint: string;
};
type RuntimeCatalogEntry = SessionMcpCatalogBinding & { catalog: McpToolCatalog | null };
type AdvertisedScopedCatalogEntry = SessionMcpCatalogBinding & {
  servers: Map<string, McpServerCatalog>;
  toolsByServer: Map<string, McpCatalogTool[]>;
  signaturesByServer: Map<string, string>;
};
export type SessionMcpCatalogStore = {
  catalogByRuntimeKey: Map<string, RuntimeCatalogEntry>;
  advertisedScopedCatalogBySessionId: Map<string, AdvertisedScopedCatalogEntry>;
};

function matchesBinding(current: SessionMcpCatalogBinding, binding: SessionMcpCatalogBinding) {
  return (
    current.configFingerprint === binding.configFingerprint &&
    current.workspaceDir === binding.workspaceDir &&
    current.agentDir === binding.agentDir &&
    current.agentId === binding.agentId &&
    current.sessionKey === binding.sessionKey
  );
}

/** Catalog lifetime follows sessions, independently of transport eviction. */
export function createSessionMcpCatalogStore(
  runtimes: ReadonlyMap<string, SessionMcpRuntime>,
  now: () => number,
) {
  const store: SessionMcpCatalogStore = {
    catalogByRuntimeKey: new Map(),
    advertisedScopedCatalogBySessionId: new Map(),
  };
  const { catalogByRuntimeKey, advertisedScopedCatalogBySessionId } = store;
  const sessionEntries = (sessionId: string): SessionMcpCatalogBinding[] => [
    ...[...catalogByRuntimeKey.values()].filter((entry) => entry.sessionId === sessionId),
    ...[advertisedScopedCatalogBySessionId.get(sessionId)].filter((entry) => entry !== undefined),
  ];
  const hasSession = (sessionId: string) => sessionEntries(sessionId).length > 0;
  const deleteSession = (sessionId: string) => {
    for (const [key, entry] of catalogByRuntimeKey) {
      if (entry.sessionId === sessionId) {
        catalogByRuntimeKey.delete(key);
      }
    }
    advertisedScopedCatalogBySessionId.delete(sessionId);
  };
  const reconcileCatalog = (runtimeKey: string, binding: SessionMcpCatalogBinding) => {
    const current = catalogByRuntimeKey.get(runtimeKey);
    catalogByRuntimeKey.delete(runtimeKey);
    if (current && matchesBinding(current, binding)) {
      catalogByRuntimeKey.set(runtimeKey, current);
    }
  };
  const rememberAdvertisedScopedCatalog = (
    handle: RequesterScopedMcpRuntimeHandle,
    catalog: McpToolCatalog,
  ) => {
    const entry = advertisedScopedCatalogBySessionId.get(handle.runtime.sessionId);
    const runtimeKey = [...runtimes].find(([, runtime]) => runtime === handle.runtime)?.[0];
    // Publish only the current owner's recorded discovery, never a pre-reload result.
    if (
      entry?.configFingerprint !== handle.advertisedCatalogConfigFingerprint ||
      runtimeKey === undefined ||
      catalogByRuntimeKey.get(runtimeKey)?.catalog !== catalog
    ) {
      return;
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
      const signature = mcpCatalogToolsSignature(tools);
      if (entry.signaturesByServer.get(serverName) !== signature) {
        entry.servers.set(serverName, server);
        entry.toolsByServer.set(serverName, tools);
        entry.signaturesByServer.set(serverName, signature);
      }
    }
  };
  const observed = new WeakSet<SessionMcpRuntime>();
  const observeCatalog = (
    runtime: SessionMcpRuntime,
    runtimeKey: string,
    binding: SessionMcpCatalogBinding,
  ) => {
    reconcileCatalog(runtimeKey, binding);
    if (!catalogByRuntimeKey.has(runtimeKey)) {
      catalogByRuntimeKey.set(runtimeKey, { ...binding, catalog: null });
    }
    if (observed.has(runtime)) {
      return;
    }
    observed.add(runtime);
    const getCatalog = runtime.getCatalog.bind(runtime);
    runtime.getCatalog = async () => {
      const publication = catalogByRuntimeKey.get(runtimeKey);
      const catalog = await getCatalog();
      // A reset, replacement or reload must not resurrect a late discovery result.
      if (
        publication &&
        catalogByRuntimeKey.get(runtimeKey) === publication &&
        runtimes.get(runtimeKey) === runtime &&
        sessionMcpRuntimeOwners.get(runtime)?.isCurrent() !== false
      ) {
        publication.catalog = catalog;
      }
      return catalog;
    };
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
    tools.sort(compareMcpCatalogTools);
    return { version: 1, generatedAt: now(), servers, tools };
  };
  const reconcileAdvertisedScopedCatalogConfig = (
    binding: SessionMcpCatalogBinding,
    preparePublication: boolean,
  ) => {
    const current = advertisedScopedCatalogBySessionId.get(binding.sessionId);
    advertisedScopedCatalogBySessionId.delete(binding.sessionId);
    if (current && matchesBinding(current, binding)) {
      advertisedScopedCatalogBySessionId.set(binding.sessionId, current);
      return;
    }
    // Scope/config changes invalidate every requester partition's remembered schema.
    for (const [key, entry] of catalogByRuntimeKey) {
      if (key !== binding.sessionId && entry.sessionId === binding.sessionId) {
        catalogByRuntimeKey.delete(key);
      }
    }
    if (preparePublication) {
      advertisedScopedCatalogBySessionId.set(binding.sessionId, {
        ...binding,
        servers: new Map(),
        toolsByServer: new Map(),
        signaturesByServer: new Map(),
      });
    }
  };
  const prune = (
    ownedSessionIds: ReadonlySet<string>,
    ownedRuntimeKeys: ReadonlySet<string>,
    activeSessionIds: ReadonlySet<string>,
  ) => {
    // Both catalogs use acquisition order, including refused reuse. Runtime keys
    // bound retired requesters even when a different partition remains live.
    const pruneMap = <T>(
      entries: Map<string, T>,
      keep: (key: string, entry: T) => boolean,
      populated: (entry: T) => boolean,
    ) => {
      const evicted: string[] = [];
      for (const [key, entry] of entries) {
        if (!keep(key, entry)) {
          if (populated(entry)) {
            evicted.push(key);
          } else {
            entries.delete(key);
          }
        }
      }
      for (const key of evicted.slice(0, -SESSION_MCP_MAX_LIVE_RUNTIMES)) {
        entries.delete(key);
      }
    };
    pruneMap(
      catalogByRuntimeKey,
      (key, entry) => ownedRuntimeKeys.has(key) || activeSessionIds.has(entry.sessionId),
      (entry) => entry.catalog !== null,
    );
    const retainedSnapshotSessions = new Set(
      [...catalogByRuntimeKey.values()].map((entry) => entry.sessionId),
    );
    pruneMap(
      advertisedScopedCatalogBySessionId,
      (key) => ownedSessionIds.has(key),
      (entry) => entry.servers.size > 0 || retainedSnapshotSessions.has(entry.sessionId),
    );
  };
  return {
    store,
    sessionEntries,
    hasSession,
    deleteSession,
    reconcileCatalog,
    observeCatalog,
    rememberAdvertisedScopedCatalog,
    getAdvertisedScopedCatalog,
    reconcileAdvertisedScopedCatalogConfig,
    prune,
    clear: () => {
      catalogByRuntimeKey.clear();
      advertisedScopedCatalogBySessionId.clear();
    },
    captureSession(sessionId: string) {
      const entries = sessionEntries(sessionId);
      return entries.length
        ? () => {
            const current = sessionEntries(sessionId);
            return (
              current.length === entries.length && entries.every((entry) => current.includes(entry))
            );
          }
        : undefined;
    },
  };
}
