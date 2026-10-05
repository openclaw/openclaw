import type {
  BundleMcpDataDirOwnership,
  BundleMcpDiagnostic,
  BundleMcpServerConfig,
} from "../plugins/bundle-mcp.js";
import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";

type EmbeddedAgentMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
  diagnostics: BundleMcpDiagnostic[];
  pluginIdsByServer?: Record<string, string>;
  prepareDataDirsByServer: Record<string, BundleMcpDataDirOwnership>;
};

export function loadEmbeddedAgentMcpConfig(
  params: Parameters<typeof loadMergedBundleMcpConfig>[0],
): EmbeddedAgentMcpConfig {
  const bundleMcp = loadMergedBundleMcpConfig(params);

  return {
    mcpServers: bundleMcp.config.mcpServers,
    diagnostics: bundleMcp.diagnostics,
    pluginIdsByServer: bundleMcp.pluginIdsByServer,
    prepareDataDirsByServer: bundleMcp.prepareDataDirsByServer,
  };
}
