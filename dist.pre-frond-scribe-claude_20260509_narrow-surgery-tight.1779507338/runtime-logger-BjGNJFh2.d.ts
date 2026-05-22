import { n as RuntimeEnv, t as OutputRuntimeEnv } from "./runtime-Bxifh4bY.js";

//#region src/plugin-sdk/runtime-logger.d.ts
/** Minimal logger contract accepted by runtime-adapter helpers. */
type LoggerLike = {
  info: (message: string) => void;
  error: (message: string) => void;
};
/** @deprecated Import from `openclaw/plugin-sdk/runtime` instead. */
declare function createLoggerBackedRuntime(params: {
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
/** @deprecated Import from `openclaw/plugin-sdk/runtime` instead. */
declare function resolveRuntimeEnv(params: {
  runtime: RuntimeEnv;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): RuntimeEnv;
declare function resolveRuntimeEnv(params: {
  runtime?: undefined;
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
/** @deprecated Import from `openclaw/plugin-sdk/runtime` instead. */
declare function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime: RuntimeEnv;
  logger: LoggerLike;
  unavailableMessage?: string;
}): RuntimeEnv;
declare function resolveRuntimeEnvWithUnavailableExit(params: {
  runtime?: undefined;
  logger: LoggerLike;
  unavailableMessage?: string;
}): OutputRuntimeEnv;
//#endregion
export { resolveRuntimeEnv as n, resolveRuntimeEnvWithUnavailableExit as r, createLoggerBackedRuntime as t };