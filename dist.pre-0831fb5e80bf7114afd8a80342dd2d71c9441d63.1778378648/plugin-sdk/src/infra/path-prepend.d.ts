/**
 * Find the actual key used for PATH in the env object.
 * On Windows, `process.env` stores it as `Path` (not `PATH`),
 * and after copying to a plain object the original casing is preserved.
 */
export declare function findPathKey(env: Record<string, string>): string;
export declare function normalizePathPrepend(entries?: string[]): string[];
export declare function mergePathPrepend(existing: string | undefined, prepend: string[]): string | undefined;
export declare function applyPathPrepend(env: Record<string, string>, prepend: string[] | undefined, options?: {
    requireExisting?: boolean;
}): void;
