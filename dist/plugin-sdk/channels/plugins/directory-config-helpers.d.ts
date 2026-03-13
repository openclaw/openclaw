import type { ChannelDirectoryEntry } from "./types.js";
export declare function listDirectoryUserEntriesFromAllowFrom(params: {
    allowFrom?: readonly unknown[];
    query?: string | null;
    limit?: number | null;
    normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listDirectoryUserEntriesFromAllowFromAndMapKeys(params: {
    allowFrom?: readonly unknown[];
    map?: Record<string, unknown>;
    query?: string | null;
    limit?: number | null;
    normalizeAllowFromId?: (entry: string) => string | null | undefined;
    normalizeMapKeyId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listDirectoryGroupEntriesFromMapKeys(params: {
    groups?: Record<string, unknown>;
    query?: string | null;
    limit?: number | null;
    normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
export declare function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params: {
    groups?: Record<string, unknown>;
    allowFrom?: readonly unknown[];
    query?: string | null;
    limit?: number | null;
    normalizeMapKeyId?: (entry: string) => string | null | undefined;
    normalizeAllowFromId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[];
