//#region src/runtime.d.ts
type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};
type OutputRuntimeEnv = RuntimeEnv & {
  writeStdout: (value: string) => void;
  writeJson: (value: unknown, space?: number) => void;
};
declare const defaultRuntime: OutputRuntimeEnv;
declare function createNonExitingRuntime(): OutputRuntimeEnv;
//#endregion
export { defaultRuntime as i, RuntimeEnv as n, createNonExitingRuntime as r, OutputRuntimeEnv as t };