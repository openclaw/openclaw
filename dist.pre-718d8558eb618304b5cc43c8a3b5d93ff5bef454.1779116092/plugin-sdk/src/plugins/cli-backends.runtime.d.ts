import type { CliBackendPlugin } from "./cli-backend.types.js";
export type PluginCliBackendEntry = CliBackendPlugin & {
    pluginId: string;
};
export declare function resolveRuntimeCliBackends(): PluginCliBackendEntry[];
