import type { TSchema } from "typebox";
import type { McpCodexToolApprovalMode, McpServerToolFilterConfig } from "../config/types.mcp.js";
import type {
  McpAppIcon,
  McpAppSettingsCapability,
  McpAppToolExtensions,
} from "../shared/mcp-app-extensions.js";
import type { McpCodexToolAnnotations } from "./mcp-codex-tool-approval.js";

export type McpServerCatalog = {
  serverName: string;
  safeServerName?: string;
  launchSummary: string;
  pluginId?: string;
  marketplace?: string;
  title?: string;
  icons?: McpAppIcon[];
  /** Complete server-level guidance from the upstream initialize result. */
  instructions?: string;
  settings?: McpAppSettingsCapability;
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
  toolFilter?: McpServerToolFilterConfig;
  deniedToolNames?: string[];
  codexApprovalMode?: McpCodexToolApprovalMode;
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
  appExtensions?: McpAppToolExtensions;
  uiResourceUri?: string;
  uiVisibility?: Array<"app" | "model">;
  /** Listed by the server but excluded from OpenClaw's callable tool catalog. */
  excludedFromOpenClawCatalog?: true;
  deniedBySession?: true;
  codexAnnotations?: McpCodexToolAnnotations;
  /** Trusted requester OAuth sign-in bootstrap; never dispatches into the server's tools. */
  oauthConnectBootstrap?: true;
};

export type McpToolCatalog = {
  version: number;
  generatedAt: number;
  servers: Record<string, McpServerCatalog>;
  tools: McpCatalogTool[];
  /** Complete raw catalog used to project policy into native MCP clients. */
  policyTools?: McpCatalogTool[];
  /** Listed tools hidden only by the session override, retained for read-only inventory. */
  sessionDeniedTools?: McpCatalogTool[];
  diagnostics?: readonly McpToolCatalogDiagnostic[];
};

export type McpToolCatalogDiagnostic = {
  serverName: string;
  safeServerName: string;
  launchSummary: string;
  message: string;
};
