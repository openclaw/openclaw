import type { RuntimeEnv } from "../runtime.js";
type LoggerLike = {
    info: (message: string) => void;
    error: (message: string) => void;
};
export declare function createLoggerBackedRuntime(params: {
    logger: LoggerLike;
    exitError?: (code: number) => Error;
}): RuntimeEnv;
export declare function resolveRuntimeEnv(params: {
    runtime?: RuntimeEnv;
    logger: LoggerLike;
    exitError?: (code: number) => Error;
}): RuntimeEnv;
export declare function resolveRuntimeEnvWithUnavailableExit(params: {
    runtime?: RuntimeEnv;
    logger: LoggerLike;
    unavailableMessage?: string;
}): RuntimeEnv;
export {};
