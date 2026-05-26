import { n as InstalledPluginIndexRefreshReason, t as InstalledPluginIndex } from "./installed-plugin-index-types-BNeq3o_Y.js";
//#region src/plugins/installed-plugin-index-store-path.d.ts
type InstalledPluginIndexStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  filePath?: string;
};
//#endregion
//#region src/plugins/installed-plugin-index-store.d.ts
type InstalledPluginIndexStoreState = "missing" | "fresh" | "stale";
type InstalledPluginIndexStoreInspection = {
  state: InstalledPluginIndexStoreState;
  refreshReasons: readonly InstalledPluginIndexRefreshReason[];
  persisted: InstalledPluginIndex | null;
  current: InstalledPluginIndex;
};
//#endregion
export { InstalledPluginIndexStoreOptions as n, InstalledPluginIndexStoreInspection as t };