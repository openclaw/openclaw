import type { OpenClawConfig } from "../config/config.js";
export declare const DEFAULT_COMMITMENT_EXTRACTION_QUEUE_MAX_ITEMS = 64;
export declare const DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT = 3;
export declare const DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS = 72;
type ResolvedCommitmentsConfig = {
    enabled: boolean;
    maxPerDay: number;
    extraction: {
        debounceMs: number;
        batchMaxItems: number;
        queueMaxItems: number;
        confidenceThreshold: number;
        careConfidenceThreshold: number;
        timeoutSeconds: number;
    };
};
export declare function resolveCommitmentsConfig(cfg?: OpenClawConfig): ResolvedCommitmentsConfig;
export declare function resolveCommitmentTimezone(cfg?: OpenClawConfig): string;
export {};
