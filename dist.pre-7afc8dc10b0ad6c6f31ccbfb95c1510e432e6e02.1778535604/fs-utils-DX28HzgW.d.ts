//#region packages/memory-host-sdk/src/host/fs-utils.d.ts
declare function isFileMissingError(err: unknown): err is NodeJS.ErrnoException & {
  code: "ENOENT";
};
//#endregion
export { isFileMissingError as t };