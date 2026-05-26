import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
export declare function createPreparedEmbeddedPiSettingsManager(params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    /** Resolved context window budget so reserve-token floor can be capped for small models. */
    contextTokenBudget?: number;
}): SettingsManager;
