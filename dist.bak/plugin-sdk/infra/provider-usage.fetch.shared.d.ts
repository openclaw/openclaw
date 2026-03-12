import type { ProviderUsageSnapshot, UsageProviderId } from "./provider-usage.types.js";
export declare function fetchJson(url: string, init: RequestInit, timeoutMs: number, fetchFn: typeof fetch): Promise<Response>;
export declare function parseFiniteNumber(value: unknown): number | undefined;
type BuildUsageHttpErrorSnapshotOptions = {
    provider: UsageProviderId;
    status: number;
    message?: string;
    tokenExpiredStatuses?: readonly number[];
};
export declare function buildUsageErrorSnapshot(provider: UsageProviderId, error: string): ProviderUsageSnapshot;
export declare function buildUsageHttpErrorSnapshot(options: BuildUsageHttpErrorSnapshotOptions): ProviderUsageSnapshot;
export {};
