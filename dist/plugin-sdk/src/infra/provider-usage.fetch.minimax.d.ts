import type { ProviderUsageSnapshot } from "./provider-usage.types.js";
type FetchMinimaxUsageOptions = {
    baseUrl?: string;
};
export declare function fetchMinimaxUsage(apiKey: string, timeoutMs: number, fetchFn: typeof fetch, options?: FetchMinimaxUsageOptions): Promise<ProviderUsageSnapshot>;
export {};
