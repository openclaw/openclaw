import type { ProviderUsageSnapshot } from "./provider-usage.types.js";
export declare function fetchMinimaxUsage(apiKey: string, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
