import type { PluginLogger } from "./types.js";
type LoggerLike = {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug?: (message: string) => void;
};
export declare function createPluginLoaderLogger(logger: LoggerLike): PluginLogger;
export {};
