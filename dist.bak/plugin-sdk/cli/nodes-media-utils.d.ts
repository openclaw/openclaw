export declare function asRecord(value: unknown): Record<string, unknown>;
export declare function asString(value: unknown): string | undefined;
export declare function asNumber(value: unknown): number | undefined;
export declare function asBoolean(value: unknown): boolean | undefined;
export declare function resolveTempPathParts(opts: {
    ext: string;
    tmpDir?: string;
    id?: string;
}): {
    ext: string;
    tmpDir: string;
    id: string;
};
