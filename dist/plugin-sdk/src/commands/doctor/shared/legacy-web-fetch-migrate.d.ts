export declare function listLegacyWebFetchConfigPaths(raw: unknown): string[];
export declare function migrateLegacyWebFetchConfig<T>(raw: T): {
    config: T;
    changes: string[];
};
