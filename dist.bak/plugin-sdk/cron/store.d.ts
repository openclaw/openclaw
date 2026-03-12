import type { CronStoreFile } from "./types.js";
export declare const DEFAULT_CRON_DIR: string;
export declare const DEFAULT_CRON_STORE_PATH: string;
export declare function resolveCronStorePath(storePath?: string): string;
export declare function loadCronStore(storePath: string): Promise<CronStoreFile>;
export declare function saveCronStore(storePath: string, store: CronStoreFile): Promise<void>;
