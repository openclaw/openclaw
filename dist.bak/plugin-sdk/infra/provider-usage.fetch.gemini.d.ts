import type { ProviderUsageSnapshot, UsageProviderId } from "./provider-usage.types.js";
export declare function fetchGeminiUsage(token: string, timeoutMs: number, fetchFn: typeof fetch, provider: UsageProviderId): Promise<ProviderUsageSnapshot>;
