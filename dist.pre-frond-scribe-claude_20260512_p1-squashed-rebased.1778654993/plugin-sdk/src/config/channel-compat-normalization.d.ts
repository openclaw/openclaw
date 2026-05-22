import { normalizeLegacyDmAliases, type CompatMutationResult } from "../channels/plugins/dm-access.js";
export { normalizeLegacyDmAliases };
export type { CompatMutationResult };
export type LegacyStreamingAliasOptions = {
    resolvedMode: string;
    includePreviewChunk?: boolean;
    resolvedNativeTransport?: unknown;
    offModeLegacyNotice?: (pathPrefix: string) => string;
};
export type NormalizeLegacyChannelAccountParams = {
    account: Record<string, unknown>;
    accountId: string;
    pathPrefix: string;
    changes: string[];
};
export declare function asObjectRecord(value: unknown): Record<string, unknown> | null;
export declare function hasLegacyAccountStreamingAliases(value: unknown, match: (entry: unknown) => boolean): boolean;
export declare function normalizeLegacyStreamingAliases(params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
} & LegacyStreamingAliasOptions): CompatMutationResult;
export declare function normalizeLegacyChannelAliases(params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
    normalizeDm?: boolean;
    rootDmPromoteAllowFrom?: boolean;
    normalizeAccountDm?: boolean;
    resolveStreamingOptions: (entry: Record<string, unknown>) => LegacyStreamingAliasOptions;
    normalizeAccountExtra?: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
}): CompatMutationResult;
export declare function hasLegacyStreamingAliases(value: unknown, options?: {
    includePreviewChunk?: boolean;
    includeNativeTransport?: boolean;
}): boolean;
