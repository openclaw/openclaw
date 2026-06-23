import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic } from "../plugins/bundle-mcp.js";
import type { McpServerSelection } from "./agent-bundle-mcp-types.js";

export type CodexMcpServersConfig = Record<string, Record<string, unknown>>;

export type CodexBundleMcpThreadConfig = {
  configPatch?: {
    mcp_servers: CodexMcpServersConfig;
  };
  diagnostics: BundleMcpDiagnostic[];
  evaluated: boolean;
  fingerprint?: string;
  selectedMcpServers?: McpServerSelection;
};

export type LoadCodexBundleMcpThreadConfigParams = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  toolsEnabled?: boolean;
  disableTools?: boolean;
  toolsAllow?: string[];
};
