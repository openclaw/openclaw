import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic } from "../plugins/bundle-mcp.js";

export type CodexMcpServersConfig = Record<string, Record<string, unknown>>;

export type CodexBundleMcpThreadConfig = {
  configPatch?: {
    mcp_servers: CodexMcpServersConfig;
  };
  diagnostics: BundleMcpDiagnostic[];
  fingerprint?: string;
};

export type LoadCodexBundleMcpThreadConfigParams = {
  workspaceDir: string;
  cfg?: OpenClawConfig;
};
