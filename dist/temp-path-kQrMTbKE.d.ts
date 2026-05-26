//#region src/infra/temp-download.d.ts
type TempDownloadTarget = {
  dir: string;
  path: string;
  file(fileName?: string): string;
  cleanup: () => Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};
declare function sanitizeTempFileName(fileName: string): string;
declare function buildRandomTempFilePath(params: {
  prefix: string;
  extension?: string;
  tmpDir?: string;
  now?: number;
  uuid?: string;
}): string;
declare function createTempDownloadTarget(params: {
  prefix: string;
  fileName?: string;
  tmpDir?: string;
}): Promise<TempDownloadTarget>;
declare function withTempDownloadPath<T>(params: {
  prefix: string;
  fileName?: string;
  tmpDir?: string;
}, fn: (tmpPath: string) => Promise<T>): Promise<T>;
//#endregion
export { withTempDownloadPath as i, createTempDownloadTarget as n, sanitizeTempFileName as r, buildRandomTempFilePath as t };