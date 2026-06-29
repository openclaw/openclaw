/** Shared bundle MCP catalog, runtime, and manager types. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TSchema } from "typebox";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./tools/common.js";

/** Materialized MCP tools plus diagnostics and cleanup handle for one run. */
export type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  diagnostics?: readonly McpToolCatalogDiagnostic[];
  dispose: () => Promise<void>;
};

/** Catalog metadata for one configured MCP server. */
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

/** MCP tool entry after server-name sanitization and schema normalization. */
export type McpCatalogTool = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: TSchema;
  fallbackDescription: string;
};

/** Complete tool catalog for a session-scoped MCP runtime. */
export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
  diagnostics?: readonly McpToolCatalogDiagnostic[];
};

export type McpToolCatalogDiagnostic = {
  serverName: string;
  safeServerName: string;
  launchSummary: string;
  message: string;
};

/** Live MCP runtime bound to one session/workspace. */
export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  /** Opaque key encoding the caller context baked into this runtime's MCP connections. Empty when no trusted servers exist. Used by getOrCreate to detect stale caller identity across turns. */
  callerContextKey: string;
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

/**
 * Caller identity fields injected as HTTP headers onto opted-in remote MCP
 * servers when the embedded agent connects to them. Mirrors the env vars
 * used by the CLI bundle MCP path but supplies real values directly instead
 * of `${OPENCLAW_MCP_*}` placeholder strings.
 */
export type EmbeddedMcpCallerContext = {
  agentId?: string;
  accountId?: string;
  messageChannel?: string;
};

/** Manager for session-scoped MCP runtimes and their idle lifecycle. */
export type SessionMcpRuntimeManager = {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
    callerContext?: EmbeddedMcpCallerContext;
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
