import type { RuntimeEnv } from "../runtime.js";
type LogConfigUpdatedOptions = {
    path?: string;
    backupPath?: string | false;
    suffix?: string;
};
export declare function formatConfigPath(path?: string): string;
export declare function formatConfigUpdatedMessage(path: string, opts?: LogConfigUpdatedOptions): string;
export declare function logConfigUpdated(runtime: RuntimeEnv, opts?: LogConfigUpdatedOptions): void;
export {};
