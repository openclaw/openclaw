import type { OpenClawConfig } from "../config/config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";

export type EmbeddedPiMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
};

export function loadEmbeddedPiMcpConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  /** Agent-level MCP server allowlist. undefined or ["*"] = all; specific names = filter. */
  agentMcpServers?: string[];
}): EmbeddedPiMcpConfig {
  const bundleMcp = loadEnabledBundleMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);

  // Merge bundle + global servers (global overrides bundle defaults).
  let mcpServers: Record<string, BundleMcpServerConfig> = {
    ...bundleMcp.config.mcpServers,
    ...configuredMcp,
  };

  // Apply agent allowlist filter when a specific list is provided.
  const allowlist = params.agentMcpServers;
  if (allowlist && allowlist.length > 0 && !allowlist.includes("*")) {
    const allowSet = new Set(allowlist);
    mcpServers = Object.fromEntries(
      Object.entries(mcpServers).filter(([name]) => allowSet.has(name)),
    );
  }

  return {
    mcpServers,
    diagnostics: bundleMcp.diagnostics,
  };
}
