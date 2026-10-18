import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";

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

export function makeCatalog(
  serverName: string,
  tools: McpCatalogTool[],
  server: Partial<McpServerCatalog> = {},
): McpToolCatalog {
  return {
    version: 1,
    generatedAt: 0,
    tools,
    servers: {
      [serverName]: { serverName, launchSummary: serverName, toolCount: tools.length, ...server },
    },
  };
}

/** Static transport fixture shared by materialization and outbound-policy tests. */
export function makeMcpRuntime(
  catalog: () => McpToolCatalog,
  result: () => CallToolResult,
  overrides: Partial<SessionMcpRuntime> = {},
): SessionMcpRuntime {
  return {
    sessionId: "session-collision",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => catalog(),
    peekCatalog: catalog,
    callTool: async () => result(),
    dispose: async () => {},
    ...overrides,
  };
}
