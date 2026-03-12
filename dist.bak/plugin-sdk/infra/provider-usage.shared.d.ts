import type { UsageProviderId } from "./provider-usage.types.js";
export declare const DEFAULT_TIMEOUT_MS = 5000;
export declare const PROVIDER_LABELS: Record<UsageProviderId, string>;
export declare const usageProviders: UsageProviderId[];
export declare function resolveUsageProviderId(provider?: string | null): UsageProviderId | undefined;
export declare const ignoredErrors: Set<string>;
export declare const clampPercent: (value: number) => number;
export declare const withTimeout: <T>(work: Promise<T>, ms: number, fallback: T) => Promise<T>;
