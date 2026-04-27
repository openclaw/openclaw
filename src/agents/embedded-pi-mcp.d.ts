import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpDiagnostic, BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
export type EmbeddedPiMcpConfig = {
    mcpServers: Record<string, BundleMcpServerConfig>;
    diagnostics: BundleMcpDiagnostic[];
};
export declare function loadEmbeddedPiMcpConfig(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
}): EmbeddedPiMcpConfig;
