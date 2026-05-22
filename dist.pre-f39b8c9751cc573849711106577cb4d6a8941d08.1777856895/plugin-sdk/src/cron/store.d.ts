import type { CronStoreFile } from "./types.js";
export declare function resolveCronStorePath(storePath?: string): string;
export declare function loadCronStore(storePath: string): Promise<CronStoreFile>;
export declare function loadCronStoreSync(storePath: string): CronStoreFile;
type SaveCronStoreOptions = {
    skipBackup?: boolean;
};
export declare function saveCronStore(storePath: string, store: CronStoreFile, opts?: SaveCronStoreOptions): Promise<void>;
export {};
