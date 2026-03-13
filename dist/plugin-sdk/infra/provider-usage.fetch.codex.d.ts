import type { ProviderUsageSnapshot } from "./provider-usage.types.js";
export declare function fetchCodexUsage(token: string, accountId: string | undefined, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
