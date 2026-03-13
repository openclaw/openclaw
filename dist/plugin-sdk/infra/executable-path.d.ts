export declare function isExecutableFile(filePath: string): boolean;
export declare function resolveExecutableFromPathEnv(executable: string, pathEnv: string, env?: NodeJS.ProcessEnv): string | undefined;
export declare function resolveExecutablePath(rawExecutable: string, options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): string | undefined;
