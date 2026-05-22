import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export type StaleSubagentAllowlistHit = {
    pathLabel: string;
    agentId: string;
    normalizedAgentId: string;
};
export declare function scanStaleSubagentAllowlistReferences(cfg: OpenClawConfig): StaleSubagentAllowlistHit[];
export declare function collectStaleSubagentAllowlistWarnings(params: {
    hits: readonly StaleSubagentAllowlistHit[];
    doctorFixCommand: string;
}): string[];
export declare function maybeRepairStaleSubagentAllowlists(cfg: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
};
