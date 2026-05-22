import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { FailoverReason } from "./pi-embedded-helpers/types.js";
export declare const DEFAULT_QUOTA_SUSPENSION_RESUME_MS: number;
export type SessionSuspensionReason = "quota_exhausted" | "manual" | "circuit_open";
declare function resolveLaneResumeConcurrency(cfg: OpenClawConfig | undefined, laneId: string): number;
export declare function resolveSessionSuspensionReason(reason: FailoverReason): SessionSuspensionReason;
export declare function cancelLaneAutoResume(laneId: string): void;
export declare function suspendSession(params: {
    cfg: OpenClawConfig | undefined;
    agentDir?: string;
    sessionId: string;
    laneId?: string;
    reason: SessionSuspensionReason;
    failedProvider: string;
    failedModel: string;
    summary?: string;
    ttlMs?: number;
}): Promise<void>;
export declare const testing: {
    readonly resolveLaneResumeConcurrency: typeof resolveLaneResumeConcurrency;
    readonly resolveSessionSuspensionReason: typeof resolveSessionSuspensionReason;
};
export { testing as __testing };
