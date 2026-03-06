export declare function mergeDmAllowFromSources(params: {
    allowFrom?: Array<string | number>;
    storeAllowFrom?: Array<string | number>;
    dmPolicy?: string;
}): string[];
export declare function resolveGroupAllowFromSources(params: {
    allowFrom?: Array<string | number>;
    groupAllowFrom?: Array<string | number>;
    fallbackToAllowFrom?: boolean;
}): string[];
export declare function firstDefined<T>(...values: Array<T | undefined>): (T & ({} | null)) | undefined;
export declare function isSenderIdAllowed(allow: {
    entries: string[];
    hasWildcard: boolean;
    hasEntries: boolean;
}, senderId: string | undefined, allowWhenEmpty: boolean): boolean;
