import type { AuthProfileFailureReason, ProfileUsageStats } from "./types.js";
export declare function logAuthProfileFailureStateChange(params: {
    runId?: string;
    profileId: string;
    provider: string;
    reason: AuthProfileFailureReason;
    previous: ProfileUsageStats | undefined;
    next: ProfileUsageStats;
    now: number;
}): void;
