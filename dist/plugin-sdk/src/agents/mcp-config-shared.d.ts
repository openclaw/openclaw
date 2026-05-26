export declare function isMcpConfigRecord(value: unknown): value is Record<string, unknown>;
export declare function toMcpStringRecord(value: unknown, options?: {
    onDroppedEntry?: (key: string, value: unknown) => void;
}): Record<string, string> | undefined;
export declare function toMcpEnvRecord(value: unknown, options?: {
    onDroppedEntry?: (key: string, value: unknown) => void;
}): Record<string, string> | undefined;
export declare function toMcpStringArray(value: unknown): string[] | undefined;
