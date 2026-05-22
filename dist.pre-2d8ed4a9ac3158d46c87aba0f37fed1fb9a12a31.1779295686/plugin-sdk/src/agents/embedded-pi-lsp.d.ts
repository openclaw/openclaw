import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleLspServerConfig } from "../plugins/bundle-lsp.js";
type EmbeddedPiLspConfig = {
    lspServers: Record<string, BundleLspServerConfig>;
    diagnostics: Array<{
        pluginId: string;
        message: string;
    }>;
};
export declare function loadEmbeddedPiLspConfig(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
}): EmbeddedPiLspConfig;
export {};
