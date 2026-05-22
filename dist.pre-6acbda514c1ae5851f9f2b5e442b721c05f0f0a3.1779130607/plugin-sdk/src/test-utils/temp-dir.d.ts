export declare function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T>;
