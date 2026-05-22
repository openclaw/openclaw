//#region src/infra/warning-filter.d.ts
type ProcessWarning = {
  code?: string;
  name?: string;
  message?: string;
};
declare function shouldIgnoreWarning(warning: ProcessWarning): boolean;
declare function installProcessWarningFilter(): void;
//#endregion
export { installProcessWarningFilter as n, shouldIgnoreWarning as r, ProcessWarning as t };