import type {
  McpCatalogTool,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

type Tool = Pick<McpCatalogTool, "toolName"> & Partial<McpCatalogTool>;

export function catalogTool(
  serverName: string,
  toolName: string,
  overrides: Partial<McpCatalogTool> = {},
): McpCatalogTool {
  return {
    serverName,
    safeServerName: serverName,
    toolName,
    inputSchema: { type: "object", properties: {} },
    fallbackDescription: toolName,
    ...overrides,
  };
}

export function fixtureCatalog(serverName: string, tools: Tool[], generatedAt = 0): McpToolCatalog {
  return {
    version: 1,
    generatedAt,
    servers: { [serverName]: { serverName, launchSummary: serverName, toolCount: tools.length } },
    tools: tools.map((tool) => ({
      serverName,
      safeServerName: serverName,
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: tool.description ?? tool.toolName,
      ...tool,
    })),
  };
}

export function fixtureRuntime(
  catalog: () => McpToolCatalog,
  fields: Partial<SessionMcpRuntime>,
): SessionMcpRuntime {
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  return {
    sessionId: "session",
    workspaceDir: "/workspace",
    configFingerprint: "fixture",
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    peekCatalog: () => null,
    getCatalog: async () => catalog(),
    callTool: async (_server, toolName) => ({
      content: [{ type: "text", text: toolName }],
      isError: false,
    }),
    dispose: async () => {},
    ...fields,
  };
}

export function withFixtureLeases(
  runtime: SessionMcpRuntime,
  enumerable = false,
): SessionMcpRuntime {
  const leases = new Set<symbol>();
  Object.defineProperty(runtime, "activeLeases", {
    get: () => leases.size,
    enumerable,
    configurable: enumerable,
  });
  runtime.acquireLease = () => {
    const lease = Symbol("mcp-test-lease");
    leases.add(lease);
    return () => {
      leases.delete(lease);
    };
  };
  return runtime;
}

export function bindFixtureIdentity(
  runtime: SessionMcpRuntime,
  params: Pick<
    SessionMcpRuntime,
    "sessionId" | "sessionKey" | "workspaceDir" | "requesterScope"
  > & { configFingerprint?: string },
): SessionMcpRuntime {
  return {
    ...runtime,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint: params.configFingerprint ?? "fingerprint",
    requesterScope: params.requesterScope,
  };
}

export function staticRuntime(
  fields: Omit<SessionMcpRuntime, "createdAt" | "lastUsedAt" | "markUsed" | "dispose"> &
    Partial<SessionMcpRuntime>,
): SessionMcpRuntime {
  return {
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    dispose: async () => {},
    ...fields,
  };
}
