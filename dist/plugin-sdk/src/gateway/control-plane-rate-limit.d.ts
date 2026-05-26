import type { GatewayClient } from "./server-methods/types.js";
export declare function resolveControlPlaneRateLimitKey(client: GatewayClient | null): string;
export declare function consumeControlPlaneWriteBudget(params: {
    client: GatewayClient | null;
    nowMs?: number;
}): {
    allowed: boolean;
    retryAfterMs: number;
    remaining: number;
    key: string;
};
/**
 * Remove buckets whose rate-limit window expired more than
 * CONTROL_PLANE_BUCKET_MAX_STALE_MS ago.  Called periodically
 * by the gateway maintenance timer to prevent unbounded growth.
 */
export declare function pruneStaleControlPlaneBuckets(nowMs?: number): number;
export declare const testing: {
    getControlPlaneRateLimitBucketCount(): number;
    resetControlPlaneRateLimitState(): void;
};
export { testing as __testing };
