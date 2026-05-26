export declare function resolveExecutablePathCandidate(rawExecutable: string, options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    requirePathSeparator?: boolean;
}): string | undefined;
export declare function isExecutableFile(filePath: string): boolean;
export declare function resolveExecutableFromPathEnv(executable: string, pathEnv: string, env?: NodeJS.ProcessEnv): string | undefined;
export declare function resolveExecutablePath(rawExecutable: string, options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): string | undefined;
/**
 * On Windows, resolves a bare command name to its full .cmd or .exe path by
 * probing PATH/PATHEXT without executing another resolver. On non-Windows this
 * is a no-op.
 */
export declare function resolveExecutable(cmd: string): string;
