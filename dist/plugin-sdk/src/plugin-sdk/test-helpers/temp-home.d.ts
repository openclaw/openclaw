type EnvValue = string | undefined | ((home: string) => string | undefined);
export declare function withTempHome<T>(fn: (home: string) => Promise<T>, opts?: {
    env?: Record<string, EnvValue>;
    prefix?: string;
    skipHomeCleanup?: boolean;
    skipSessionCleanup?: boolean;
}): Promise<T>;
export {};
