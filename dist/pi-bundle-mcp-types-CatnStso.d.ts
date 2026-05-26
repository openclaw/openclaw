import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { r as AnyAgentTool } from "./common-BDN0bXby.js";
import { TSchema } from "typebox";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

//#region src/agents/pi-bundle-mcp-types.d.ts
type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};
type McpServerCatalog = {
  serverName: string;
  launchSummary: string;
  toolCount: number;
};
type McpCatalogTool = {
  serverName: string;
  safeServerName: string;
  toolName: string;
  title?: string;
  description?: string;
  inputSchema: TSchema;
  fallbackDescription: string;
};
type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
};
type SessionMcpRuntime = {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  configFingerprint: string;
  createdAt: number;
  lastUsedAt: number;
  activeLeases?: number;
  acquireLease?: () => () => void;
  getCatalog: () => Promise<McpToolCatalog>;
  markUsed: () => void;
  callTool: (serverName: string, toolName: string, input: unknown) => Promise<CallToolResult>;
  dispose: () => Promise<void>;
};
type SessionMcpRuntimeManager = {
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
  sweepIdleRuntimes: () => Promise<number>;
  listSessionIds: () => string[];
};
//#endregion
export { SessionMcpRuntime as n, SessionMcpRuntimeManager as r, BundleMcpToolRuntime as t };