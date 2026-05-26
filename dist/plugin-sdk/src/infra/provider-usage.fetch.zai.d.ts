import type { ProviderUsageSnapshot } from "./provider-usage.types.js";
export declare function fetchZaiUsage(apiKey: string, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
