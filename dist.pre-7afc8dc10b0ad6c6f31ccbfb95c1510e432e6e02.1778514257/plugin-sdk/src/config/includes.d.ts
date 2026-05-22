/**
 * Config includes: $include directive for modular configs
 *
 * @example
 * ```json5
 * {
 *   "$include": "./base.json5",           // single file
 *   "$include": ["./a.json5", "./b.json5"] // merge multiple
 * }
 * ```
 */
import fs from "node:fs";
export declare const INCLUDE_KEY = "$include";
export declare const MAX_INCLUDE_DEPTH = 10;
export declare const MAX_INCLUDE_FILE_BYTES: number;
export type IncludeResolver = {
    readFile: (path: string) => string;
    readFileWithGuards?: (params: IncludeFileReadParams) => string;
    parseJson: (raw: string) => unknown;
};
type IncludeFileReadParams = {
    includePath: string;
    resolvedPath: string;
    rootRealDir: string;
    ioFs?: typeof fs;
    maxBytes?: number;
};
type ResolveConfigIncludesOptions = {
    /**
     * Additional directories outside the config directory that `$include` paths
     * may resolve into. Typically populated from `OPENCLAW_INCLUDE_ROOTS`.
     * Each entry must be an absolute path; symlinks are resolved before the
     * containment check, consistent with the config-directory boundary check.
     */
    allowedRoots?: ReadonlyArray<string>;
};
export declare class ConfigIncludeError extends Error {
    readonly includePath: string;
    readonly cause?: Error | undefined;
    constructor(message: string, includePath: string, cause?: Error | undefined);
}
export declare class CircularIncludeError extends ConfigIncludeError {
    readonly chain: string[];
    constructor(chain: string[]);
}
/** Deep merge: arrays concatenate, objects merge recursively, primitives: source wins */
export declare function deepMerge(target: unknown, source: unknown): unknown;
export declare function readConfigIncludeFileWithGuards(params: IncludeFileReadParams): string;
/**
 * Resolves all $include directives in a parsed config object.
 */
export declare function resolveConfigIncludes(obj: unknown, configPath: string, resolver?: IncludeResolver, options?: ResolveConfigIncludesOptions): unknown;
export {};
