import type { OpenClawConfig } from "../config/config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";
import { loadEnabledPluginMcpServerConfig } from "../plugins/mcp-servers.js";

export type EmbeddedPiMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
};

export function loadEmbeddedPiMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): EmbeddedPiMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const pluginMcp = loadEnabledPluginMcpServerConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);

  return {
    // OpenClaw config is the owner-managed layer, so it overrides bundle and plugin defaults.
    mcpServers: {
      ...bundleMcp.config.mcpServers,
      ...pluginMcp.config.mcpServers,
      ...configuredMcp,
    },
    diagnostics: bundleMcp.diagnostics,
  };
}
