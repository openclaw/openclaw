import { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function createPreparedEmbeddedPiSettingsManager(params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
    /** Resolved context window budget so reserve-token floor can be capped for small models. */
    contextTokenBudget?: number;
}): SettingsManager;
