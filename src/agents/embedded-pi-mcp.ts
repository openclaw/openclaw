import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { resolvePluginMcpServers } from "../plugins/mcp-servers.js";
import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";

type EmbeddedPiMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
};

export function loadEmbeddedPiMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EmbeddedPiMcpConfig {
  const pluginMcp = resolvePluginMcpServers({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
  });
  const bundleMcp = loadMergedBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    extraMcpServers: pluginMcp.mcpServers,
  });

  return {
    mcpServers: bundleMcp.config.mcpServers,
    diagnostics: [...bundleMcp.diagnostics, ...pluginMcp.diagnostics],
  };
}
