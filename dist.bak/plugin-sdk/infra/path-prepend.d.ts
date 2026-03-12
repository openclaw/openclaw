export declare function normalizePathPrepend(entries?: string[]): string[];
export declare function mergePathPrepend(existing: string | undefined, prepend: string[]): string | undefined;
export declare function applyPathPrepend(env: Record<string, string>, prepend: string[] | undefined, options?: {
    requireExisting?: boolean;
}): void;
