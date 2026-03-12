import type { ProviderUsageSnapshot } from "./provider-usage.types.js";
export declare function fetchClaudeUsage(token: string, timeoutMs: number, fetchFn: typeof fetch): Promise<ProviderUsageSnapshot>;
