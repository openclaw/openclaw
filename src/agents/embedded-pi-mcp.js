import { normalizeConfiguredMcpServers } from "../config/mcp-config.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";
export function loadEmbeddedPiMcpConfig(params) {
    const bundleMcp = loadEnabledBundleMcpConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
    });
    const configuredMcp = normalizeConfiguredMcpServers(params.cfg?.mcp?.servers);
    return {
        // OpenClaw config is the owner-managed layer, so it overrides bundle defaults.
        mcpServers: {
            ...bundleMcp.config.mcpServers,
            ...configuredMcp,
        },
        diagnostics: bundleMcp.diagnostics,
    };
}
