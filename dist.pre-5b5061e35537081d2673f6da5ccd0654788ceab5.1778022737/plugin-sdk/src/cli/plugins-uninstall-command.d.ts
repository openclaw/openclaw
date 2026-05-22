import { type RuntimeEnv } from "../runtime.js";
export type PluginUninstallOptions = {
    keepFiles?: boolean;
    /** @deprecated Use keepFiles. */
    keepConfig?: boolean;
    force?: boolean;
    dryRun?: boolean;
};
export declare function runPluginUninstallCommand(id: string, opts?: PluginUninstallOptions, runtime?: RuntimeEnv): Promise<void>;
