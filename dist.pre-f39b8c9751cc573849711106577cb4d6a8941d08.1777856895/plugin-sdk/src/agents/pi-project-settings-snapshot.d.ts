import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.js";
export declare const DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY = "sanitize";
export type EmbeddedPiProjectSettingsPolicy = "trusted" | "sanitize" | "ignore";
export type PiSettingsSnapshot = ReturnType<SettingsManager["getGlobalSettings"]> & {
    mcpServers?: Record<string, BundleMcpServerConfig>;
};
export declare function loadEnabledBundlePiSettingsSnapshot(params: {
    cwd: string;
    cfg?: OpenClawConfig;
}): PiSettingsSnapshot;
export declare function resolveEmbeddedPiProjectSettingsPolicy(cfg?: OpenClawConfig): EmbeddedPiProjectSettingsPolicy;
export declare function buildEmbeddedPiSettingsSnapshot(params: {
    globalSettings: PiSettingsSnapshot;
    pluginSettings?: PiSettingsSnapshot;
    projectSettings: PiSettingsSnapshot;
    policy: EmbeddedPiProjectSettingsPolicy;
}): PiSettingsSnapshot;
