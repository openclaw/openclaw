import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
export declare function noteMemoryRecallHealth(cfg: OpenClawConfig): Promise<void>;
export declare function maybeRepairMemoryRecallHealth(params: {
    cfg: OpenClawConfig;
    prompter: DoctorPrompter;
}): Promise<void>;
/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `openclaw doctor` — config-only checks where possible;
 * may spawn a short-lived probe process when `memory.backend=qmd` to verify
 * the configured `qmd` binary is available.
 */
export declare function noteMemorySearchHealth(cfg: OpenClawConfig, opts?: {
    gatewayMemoryProbe?: {
        checked: boolean;
        ready: boolean;
        error?: string;
        skipped?: boolean;
    };
}): Promise<void>;
