import { type RuntimeEnv } from "../runtime.js";
export type PluginsListOptions = {
    json?: boolean;
    enabled?: boolean;
    verbose?: boolean;
};
export declare function runPluginsListCommand(opts: PluginsListOptions, runtime?: RuntimeEnv): Promise<void>;
