import type { OpenClawConfig } from "../config/types.js";
import type { StatusSummary } from "./status.types.js";
export declare function redactSensitiveStatusSummary(summary: StatusSummary): StatusSummary;
export declare function getStatusSummary(options?: {
    includeSensitive?: boolean;
    includeChannelSummary?: boolean;
    config?: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
}): Promise<StatusSummary>;
