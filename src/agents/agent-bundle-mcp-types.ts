import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Materialized MCP tools plus cleanup for one bundled MCP runtime attachment. */
export type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  diagnostics?: readonly McpToolCatalogDiagnostic[];
  dispose: () => Promise<void>;
};

/** Per-server catalog metadata exposed to prompts and diagnostics. */
export type McpServerCatalog = {
  serverName: string;
  safeServerName?: string;
  launchSummary: string;
  toolCount: number;
  resources?: {
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  tools?: {
    listChanged?: boolean;
    filteredCount?: number;
  };
  requestTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
  toolFilter?: {
    include?: string[];
    exclude?: string[];
  };
};

/** One MCP tool entry after server-name sanitization and schema normalization. */
export type McpCatalogTool = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: TSchema;
  fallbackDescription: string;
};

/** Versioned MCP catalog snapshot for a session runtime. */
export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
  diagnostics?: readonly McpToolCatalogDiagnostic[];
};

/** Catalog diagnostic tied back to the MCP server launch summary. */
export type McpToolCatalogDiagnostic = {
  serverName: string;
  safeServerName: string;
  launchSummary: string;
  message: string;
};

/** Long-lived MCP runtime bound to an agent session and workspace. */
export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  activeLeases?: number;
  acquireLease?: () => () => void;
  /** Lists tools if needed and may connect MCP transports. */
  getCatalog: () => Promise<McpToolCatalog>;
  /** Returns the cached catalog only; must not start runtimes, connect transports, or issue tools/list. */
  peekCatalog: () => McpToolCatalog | null;
  markUsed: () => void;
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
  listResources?: (serverName: string) => Promise<unknown>;
  readResource?: (serverName: string, uri: string) => Promise<unknown>;
  listPrompts?: (serverName: string) => Promise<unknown>;
  getPrompt?: (serverName: string, name: string, args?: Record<string, string>) => Promise<unknown>;
  dispose: () => Promise<void>;
};

/** Owns session MCP runtime reuse, lookup, binding, idle sweeping, and disposal. */
export type SessionMcpRuntimeManager = {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => Promise<SessionMcpRuntime>;
  bindSessionKey: (sessionKey: string, sessionId: string) => void;
  resolveSessionId: (sessionKey: string) => string | undefined;
  /** Looks up an existing runtime only; must not create runtimes or connect transports. */
  peekSession: (params: {
    sessionId?: string;
    sessionKey?: string;
  }) => SessionMcpRuntime | undefined;
  disposeSession: (sessionId: string) => Promise<void>;
  disposeAll: () => Promise<void>;
  sweepIdleRuntimes: () => Promise<number>;
  listSessionIds: () => string[];
};
