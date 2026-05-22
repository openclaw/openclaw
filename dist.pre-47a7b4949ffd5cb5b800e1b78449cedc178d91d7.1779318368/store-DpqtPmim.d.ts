import { i as CronStoreFile } from "./types-De71P7JW.js";

//#region src/cron/store.d.ts
declare function resolveCronStorePath(storePath?: string): string;
declare function loadCronStore(storePath: string): Promise<CronStoreFile>;
type SaveCronStoreOptions = {
  skipBackup?: boolean;
  stateOnly?: boolean;
};
declare function saveCronStore(storePath: string, store: CronStoreFile, opts?: SaveCronStoreOptions): Promise<void>;
//#endregion
export { resolveCronStorePath as n, saveCronStore as r, loadCronStore as t };