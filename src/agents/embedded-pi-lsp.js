import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";
export function loadEmbeddedPiLspConfig(params) {
    const bundleLsp = loadEnabledBundleLspConfig({
        workspaceDir: params.workspaceDir,
        cfg: params.cfg,
    });
    // User-configured LSP servers could override bundle defaults here in the future.
    return {
        lspServers: { ...bundleLsp.config.lspServers },
        diagnostics: bundleLsp.diagnostics,
    };
}
