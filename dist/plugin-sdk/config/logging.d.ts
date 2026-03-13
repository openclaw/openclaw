import type { RuntimeEnv } from "../runtime.js";
type LogConfigUpdatedOptions = {
    path?: string;
    suffix?: string;
};
export declare function formatConfigPath(path?: string): string;
export declare function logConfigUpdated(runtime: RuntimeEnv, opts?: LogConfigUpdatedOptions): void;
export {};
