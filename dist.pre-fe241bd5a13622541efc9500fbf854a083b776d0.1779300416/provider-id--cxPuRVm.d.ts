//#region src/agents/provider-id.d.ts
declare function normalizeProviderId(provider: string): string;
/** Normalize provider ID before manifest-owned auth alias lookup. */
declare function normalizeProviderIdForAuth(provider: string): string;
declare function findNormalizedProviderValue<T>(entries: Record<string, T> | undefined, provider: string): T | undefined;
declare function findNormalizedProviderKey(entries: Record<string, unknown> | undefined, provider: string): string | undefined;
//#endregion
export { normalizeProviderIdForAuth as i, findNormalizedProviderValue as n, normalizeProviderId as r, findNormalizedProviderKey as t };