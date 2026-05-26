export declare function captureEnv(keys: string[]): {
    restore(): void;
};
export declare function createPathResolutionEnv(homeDir: string, env?: Record<string, string | undefined>): NodeJS.ProcessEnv;
export declare function withPathResolutionEnv<T>(homeDir: string, env: Record<string, string | undefined>, fn: (resolvedEnv: NodeJS.ProcessEnv) => T): T;
export declare function captureFullEnv(): {
    restore(): void;
};
export declare function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T;
export declare function withEnvAsync<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T>;
