/**
 * @deprecated Compatibility subpath. Import logger/runtime helpers from
 * `openclaw/plugin-sdk/runtime` instead.
 */
import type { OutputRuntimeEnv, RuntimeEnv } from "../runtime.js";
/** Minimal logger contract accepted by runtime-adapter helpers. */
type LoggerLike = {
    info: (message: string) => void;
    error: (message: string) => void;
};
/** @deprecated Import from `openclaw/plugin-sdk/runtime` instead. */
export declare function createLoggerBackedRuntime(params: {
    logger: LoggerLike;
    exitError?: (code: number) => Error;
}): OutputRuntimeEnv;
/** @deprecated Import from `openclaw/plugin-sdk/runtime` instead. */
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
/** @deprecated Import from `openclaw/plugin-sdk/runtime` instead. */
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
