import type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
/** Minimal logger contract accepted by runtime-adapter helpers. */
type LoggerLike = {
    info: (message: string) => void;
    error: (message: string) => void;
};
/** Adapt a simple logger into the RuntimeEnv contract used by shared plugin SDK helpers. */
export declare function createLoggerBackedRuntime(params: {
    logger: LoggerLike;
    exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
/** Reuse an existing runtime when present, otherwise synthesize one from the provided logger. */
export declare function resolveRuntimeEnv(params: {
    runtime: RuntimeEnv;
    logger: LoggerLike;
    exitError?: (code: number) => Error;
}): RuntimeEnv;
export declare function resolveRuntimeEnv(params: {
    runtime?: undefined;
    logger: LoggerLike;
    exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
/** Resolve a runtime that treats exit requests as unsupported errors instead of process termination. */
export declare function resolveRuntimeEnvWithUnavailableExit(params: {
    runtime: RuntimeEnv;
    logger: LoggerLike;
    unavailableMessage?: string;
}): RuntimeEnv;
export declare function resolveRuntimeEnvWithUnavailableExit(params: {
    runtime?: undefined;
    logger: LoggerLike;
    unavailableMessage?: string;
}): OutputRuntimeEnv;
export {};
