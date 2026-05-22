import { type RuntimeEnv } from "./runtime.js";
export declare function logInfo(message: string, runtime?: RuntimeEnv): void;
export declare function logWarn(message: string, runtime?: RuntimeEnv): void;
export declare function logSuccess(message: string, runtime?: RuntimeEnv): void;
export declare function logError(message: string, runtime?: RuntimeEnv): void;
export declare function logDebug(message: string): void;
