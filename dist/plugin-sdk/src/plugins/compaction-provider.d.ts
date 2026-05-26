/**
 * Compaction provider registry — process-global singleton.
 *
 * Plugins implement the CompactionProvider interface and register via
 * `registerCompactionProvider()`. The compaction safeguard checks this
 * registry before falling back to the built-in `summarizeInStages()`.
 */
/**
 * A pluggable compaction provider that can replace the built-in
 * summarizeInStages pipeline.
 */
export type CompactionProviderSummarizationInstructions = {
    identifierPolicy?: "strict" | "off" | "custom";
    identifierInstructions?: string;
};
export interface CompactionProvider {
    id: string;
    label: string;
    summarize(params: {
        messages: unknown[];
        signal?: AbortSignal;
        compressionRatio?: number;
        customInstructions?: string;
        summarizationInstructions?: CompactionProviderSummarizationInstructions;
        /** Summary from a prior compaction round, if re-compacting. */
        previousSummary?: string;
    }): Promise<string>;
}
/** A compaction provider with its owning plugin id for lifecycle tracking. */
export type RegisteredCompactionProvider = {
    provider: CompactionProvider;
    ownerPluginId?: string;
};
/**
 * Register a compaction provider implementation.
 * Pass `ownerPluginId` so the loader can snapshot/restore correctly.
 */
export declare function registerCompactionProvider(provider: CompactionProvider, options?: {
    ownerPluginId?: string;
}): void;
/** Return the provider for the given id, or undefined. */
export declare function getCompactionProvider(id: string): CompactionProvider | undefined;
/** Return the registered entry (provider + owner) for the given id. */
export declare function getRegisteredCompactionProvider(id: string): RegisteredCompactionProvider | undefined;
/** List all registered compaction provider ids. */
export declare function listCompactionProviderIds(): string[];
/** List all registered entries with owner metadata (for snapshot/restore). */
export declare function listRegisteredCompactionProviders(): RegisteredCompactionProvider[];
/** Clear all compaction providers. Used by clearPluginLoaderCache() and reload. */
export declare function clearCompactionProviders(): void;
/** Restore from a snapshot, replacing all current entries. */
export declare function restoreRegisteredCompactionProviders(entries: RegisteredCompactionProvider[]): void;
