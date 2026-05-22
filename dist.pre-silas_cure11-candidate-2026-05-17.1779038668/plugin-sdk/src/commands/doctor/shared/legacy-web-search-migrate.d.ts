export declare function listLegacyWebSearchConfigPaths(raw: unknown): string[];
export declare function migrateLegacyWebSearchConfig<T>(raw: T): {
    config: T;
    changes: string[];
};
