type EnvValue = string | undefined | ((home: string) => string | undefined);
export declare function withTempHome<T>(fn: (home: string) => Promise<T>, opts?: {
    env?: Record<string, EnvValue>;
    prefix?: string;
    skipSessionCleanup?: boolean;
}): Promise<T>;
export {};
