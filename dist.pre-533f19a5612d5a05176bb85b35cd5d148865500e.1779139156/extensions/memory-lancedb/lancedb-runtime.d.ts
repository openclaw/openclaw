import * as _$_lancedb_lancedb0 from "@lancedb/lancedb";

//#region extensions/memory-lancedb/lancedb-runtime.d.ts
type LanceDbModule = typeof _$_lancedb_lancedb0;
type LanceDbRuntimeLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};
type LanceDbRuntimeLoaderDeps = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  importBundled: () => Promise<LanceDbModule>;
};
declare function createLanceDbRuntimeLoader(overrides?: Partial<LanceDbRuntimeLoaderDeps>): {
  load: (loggerInstance?: LanceDbRuntimeLogger) => Promise<LanceDbModule>;
};
declare function loadLanceDbModule(logger?: LanceDbRuntimeLogger): Promise<LanceDbModule>;
//#endregion
export { LanceDbRuntimeLogger, createLanceDbRuntimeLoader, loadLanceDbModule };