//#region extensions/memory-lancedb/test-helpers.d.ts
declare function installTmpDirHarness(params: {
  prefix: string;
}): {
  getTmpDir: () => string;
  getDbPath: () => string;
};
//#endregion
export { installTmpDirHarness };