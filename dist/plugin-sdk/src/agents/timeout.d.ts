import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number;
export declare function resolveAgentTimeoutMs(opts: {
    cfg?: OpenClawConfig;
    overrideMs?: number | null;
    overrideSeconds?: number | null;
    minMs?: number;
}): number;
