import { type RuntimeEnv } from "../runtime.js";
export type PluginsSearchOptions = {
    json?: boolean;
    limit?: number;
};
export declare function runPluginsSearchCommand(queryParts: string[] | string, opts?: PluginsSearchOptions, runtime?: RuntimeEnv): Promise<void>;
