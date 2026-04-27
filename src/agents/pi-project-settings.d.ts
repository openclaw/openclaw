import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export { buildEmbeddedPiSettingsSnapshot, loadEnabledBundlePiSettingsSnapshot, resolveEmbeddedPiProjectSettingsPolicy, } from "./pi-project-settings-snapshot.js";
export declare function createEmbeddedPiSettingsManager(params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
}): SettingsManager;
export declare function createPreparedEmbeddedPiSettingsManager(params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
    /** Resolved context window budget so reserve-token floor can be capped for small models. */
    contextTokenBudget?: number;
}): SettingsManager;
