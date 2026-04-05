import type { MullusiConfig } from "../config/config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";

export type EmbeddedPiMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
};

export function loadEmbeddedPiMcpConfig(params: {
  workspaceDir: string;
  cfg?: MullusiConfig;
}): EmbeddedPiMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);

  return {
    // Mullusi config is the owner-managed layer, so it overrides bundle defaults.
    mcpServers: {
      ...bundleMcp.config.mcpServers,
      ...configuredMcp,
    },
    diagnostics: bundleMcp.diagnostics,
  };
}
