//#region node_modules/@openclaw/fs-safe/dist/timing.d.ts
declare function withTimeout<T>(promise: Promise<T>, timeoutMs: number, labelOrOptions?: string | {
  label?: string;
  message?: string;
  createError?: () => Error;
}): Promise<T>;
//#endregion
export { withTimeout as t };