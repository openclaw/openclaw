import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type BundleMcpConfig, type BundleMcpDiagnostic, type BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
type MergedBundleMcpConfig = {
    config: BundleMcpConfig;
    diagnostics: BundleMcpDiagnostic[];
};
type BundleMcpServerMapper = (server: BundleMcpServerConfig, name: string) => BundleMcpServerConfig;
/**
 * User config stores OpenClaw MCP transport names, while CLI backends such as
 * Claude Code and Gemini expect a downstream `type` field. Keep this adapter
 * out of the generic merge path because embedded Pi still consumes the raw
 * OpenClaw `transport` shape directly.
 */
export declare function toCliBundleMcpServerConfig(server: BundleMcpServerConfig): BundleMcpServerConfig;
export declare function loadMergedBundleMcpConfig(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    mapConfiguredServer?: BundleMcpServerMapper;
}): MergedBundleMcpConfig;
export {};
