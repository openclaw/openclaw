import type { RuntimeEnv } from "../runtime.js";
type LoggerLike = {
    info: (message: string) => void;
    error: (message: string) => void;
};
export declare function createLoggerBackedRuntime(params: {
    logger: LoggerLike;
    exitError?: (code: number) => Error;
}): RuntimeEnv;
export {};
