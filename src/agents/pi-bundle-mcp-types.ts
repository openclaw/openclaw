import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AnyAgentTool } from "./tools/common.js";

export type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

export type McpServerCatalog = {
  serverName: string;
  launchSummary: string;
  toolCount: number;
  resourceCount: number;
};

export type McpCatalogTool = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
  fallbackDescription: string;
};

export type McpCatalogResource = {
  serverName: string;
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
};

export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
  resources: McpCatalogResource[];
};

export type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  getCatalog: () => Promise<McpToolCatalog>;
  markUsed: () => void;
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
  listResources: (serverName?: string) => Promise<McpCatalogResource[]>;
  readResource: (serverName: string, uri: string) => Promise<unknown>;
  getServerAuthState: (serverName: string) => Promise<{
    server: string;
    status: "connected" | "disconnected";
    toolCount: number;
    resourceCount: number;
  }>;
  dispose: () => Promise<void>;
};

export type SessionMcpRuntimeManager = {
  getOrCreate: (params: {
    sessionId: string;
    sessionKey?: string;
    workspaceDir: string;
    cfg?: OpenClawConfig;
  }) => Promise<SessionMcpRuntime>;
  bindSessionKey: (sessionKey: string, sessionId: string) => void;
  resolveSessionId: (sessionKey: string) => string | undefined;
  disposeSession: (sessionId: string) => Promise<void>;
  disposeAll: () => Promise<void>;
  listSessionIds: () => string[];
};
