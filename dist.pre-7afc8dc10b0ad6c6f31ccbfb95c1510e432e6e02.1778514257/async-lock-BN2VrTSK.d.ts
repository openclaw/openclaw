//#region node_modules/@openclaw/fs-safe/dist/async-lock.d.ts
declare function createAsyncLock(): <T>(fn: () => Promise<T>) => Promise<T>;
//#endregion
export { createAsyncLock as t };