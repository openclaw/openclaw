export declare function normalizeProviderId(provider: string): string;
/** Normalize provider ID before manifest-owned auth alias lookup. */
export declare function normalizeProviderIdForAuth(provider: string): string;
export declare function findNormalizedProviderValue<T>(entries: Record<string, T> | undefined, provider: string): T | undefined;
export declare function findNormalizedProviderKey(entries: Record<string, unknown> | undefined, provider: string): string | undefined;
