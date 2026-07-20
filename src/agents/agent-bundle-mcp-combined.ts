/** Combined session MCP runtime facade for static + requester partitions. */
import { waitForSessionMcpRequest } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpCatalogTool,
  McpRequestOptions,
  McpServerCatalog,
  McpToolCatalog,
  McpToolCatalogDiagnostic,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

const COMBINED_SESSION_MCP_RUNTIME = Symbol.for("openclaw.combinedSessionMcpRuntime");

type CombinedSessionMcpRuntime = SessionMcpRuntime & {
  [COMBINED_SESSION_MCP_RUNTIME]: true;
  managedParts: readonly SessionMcpRuntime[];
};

export function isCombinedSessionMcpRuntime(
  runtime: SessionMcpRuntime,
): runtime is CombinedSessionMcpRuntime {
  return (runtime as CombinedSessionMcpRuntime)[COMBINED_SESSION_MCP_RUNTIME] !== undefined;
}

/**
 * Merge catalogs from static + requester partitions.
 * Safe names are precomputed from the full declared set, so no re-suffix is needed.
 */
export function mergeMcpToolCatalogs(catalogs: readonly McpToolCatalog[]): McpToolCatalog {
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

export function createCombinedSessionMcpRuntime(params: {
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

  const loadCatalog = async (
    options?: Pick<McpRequestOptions, "signal">,
  ): Promise<McpToolCatalog> => {
    if (cachedCatalog && cachedCatalogIsCurrent()) {
      options?.signal?.throwIfAborted();
      return cachedCatalog;
    }
    if (catalogInFlight) {
      return await waitForSessionMcpRequest(catalogInFlight, options?.signal);
    }
    const inFlight = (async () => {
      // The combined catalog belongs to the runtime. Individual operation
      // deadlines only detach their waiters; parts keep warming shared caches.
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
    void inFlight
      .finally(() => {
        if (catalogInFlight === inFlight) {
          catalogInFlight = undefined;
        }
      })
      .catch(() => {});
    return await waitForSessionMcpRequest(inFlight, options?.signal);
  };

  // Fresh combined facades have an empty owner map until the catalog is loaded.
  // Share one in-flight getCatalog so concurrent tool/resource calls do not fan out.
  const ownerForServer = async (
    serverName: string,
    options?: Pick<McpRequestOptions, "signal">,
  ): Promise<SessionMcpRuntime> => {
    if (serverOwner.size === 0) {
      await loadCatalog(options);
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
    getServerRequestTimeoutMs(serverName) {
      return serverOwner.get(serverName)?.getServerRequestTimeoutMs(serverName);
    },
    markUsed() {
      lastUsedAt = Date.now();
      for (const part of parts) {
        part.markUsed();
      }
    },
    async callTool(serverName, toolName, input, options) {
      return await (
        await ownerForServer(serverName, options)
      ).callTool(serverName, toolName, input, options);
    },
    async listTools(serverName, requestParams, options) {
      const owner = await ownerForServer(serverName, options);
      if (!owner.listTools) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listTools`);
      }
      return await owner.listTools(serverName, requestParams, options);
    },
    async listResources(serverName, options) {
      const owner = await ownerForServer(serverName, options);
      if (!owner.listResources) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listResources`);
      }
      return await owner.listResources(serverName, options);
    },
    async readResource(serverName, uri, options) {
      const owner = await ownerForServer(serverName, options);
      if (!owner.readResource) {
        throw new Error(`bundle-mcp server "${serverName}" does not support readResource`);
      }
      return await owner.readResource(serverName, uri, options);
    },
    async listResourceTemplates(serverName, requestParams, options) {
      const owner = await ownerForServer(serverName, options);
      if (!owner.listResourceTemplates) {
        throw new Error(`bundle-mcp server "${serverName}" does not support listResourceTemplates`);
      }
      return await owner.listResourceTemplates(serverName, requestParams, options);
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
      catalogInFlight = undefined;
      await Promise.allSettled(parts.map((part) => part.dispose()));
    },
  };
  return combined;
}
