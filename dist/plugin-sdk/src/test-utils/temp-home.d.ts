export type TempHomeEnv = {
    home: string;
    restore: () => Promise<void>;
};
export declare function createTempHomeEnv(prefix: string): Promise<TempHomeEnv>;
