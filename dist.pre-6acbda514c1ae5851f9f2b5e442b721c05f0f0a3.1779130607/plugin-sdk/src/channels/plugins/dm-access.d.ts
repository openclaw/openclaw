export type ChannelDmAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";
export type ChannelDmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type ChannelDmAccess = {
    dmPolicy?: ChannelDmPolicy;
    allowFrom?: Array<string | number>;
};
export type DmAccessRecord = Record<string, unknown>;
export type CompatMutationResult = {
    entry: DmAccessRecord;
    changed: boolean;
};
export declare function normalizeChannelDmPolicy(value: string | undefined): ChannelDmPolicy | undefined;
export declare function resolveChannelDmPolicy(params: {
    account?: DmAccessRecord | null;
    parent?: DmAccessRecord | null;
    mode?: ChannelDmAllowFromMode;
    defaultPolicy?: string;
}): ChannelDmPolicy | undefined;
export declare function resolveChannelDmAllowFrom(params: {
    account?: DmAccessRecord | null;
    parent?: DmAccessRecord | null;
    mode?: ChannelDmAllowFromMode;
}): Array<string | number> | undefined;
export declare function resolveChannelDmAccess(params: {
    account?: DmAccessRecord | null;
    parent?: DmAccessRecord | null;
    mode?: ChannelDmAllowFromMode;
    defaultPolicy?: string;
}): ChannelDmAccess;
export declare function setCanonicalDmAllowFrom(params: {
    entry: DmAccessRecord;
    mode: ChannelDmAllowFromMode;
    allowFrom: Array<string | number>;
    pathPrefix: string;
    changes?: string[];
    reason: string;
}): void;
export declare function normalizeLegacyDmAliases(params: {
    entry: DmAccessRecord;
    pathPrefix: string;
    changes: string[];
    promoteAllowFrom?: boolean;
}): CompatMutationResult;
export declare function ensureOpenDmPolicyAllowFromWildcard(params: {
    entry: DmAccessRecord;
    mode: ChannelDmAllowFromMode;
    pathPrefix: string;
    changes: string[];
}): void;
