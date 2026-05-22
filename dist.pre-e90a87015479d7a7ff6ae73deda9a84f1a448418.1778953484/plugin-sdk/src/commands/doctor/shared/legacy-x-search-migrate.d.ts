export declare function listLegacyXSearchConfigPaths(raw: unknown): string[];
export declare function migrateLegacyXSearchConfig<T>(raw: T): {
    config: T;
    changes: string[];
};
