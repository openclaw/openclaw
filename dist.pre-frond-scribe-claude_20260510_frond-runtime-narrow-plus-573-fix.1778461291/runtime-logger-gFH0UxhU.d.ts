import { n as RuntimeEnv, t as OutputRuntimeEnv } from "./runtime-lEKWbTQa.js";

//#region src/plugin-sdk/runtime-logger.d.ts
/** Minimal logger contract accepted by runtime-adapter helpers. */
type LoggerLike = {
  info: (message: string) => void;
  error: (message: string) => void;
};
/** Adapt a simple logger into the RuntimeEnv contract used by shared plugin SDK helpers. */
declare function createLoggerBackedRuntime(params: {
  logger: LoggerLike;
  exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
/** Reuse an existing runtime when present, otherwise synthesize one from the provided logger. */
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
/** Resolve a runtime that treats exit requests as unsupported errors instead of process termination. */
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