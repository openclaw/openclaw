import { loadMergedBundleMcpConfig } from "./bundle-mcp-config.js";

export function loadEmbeddedAgentMcpConfig(
  params: Parameters<typeof loadMergedBundleMcpConfig>[0],
) {
  const { config, ...metadata } = loadMergedBundleMcpConfig(params);
  return { ...config, ...metadata };
}
