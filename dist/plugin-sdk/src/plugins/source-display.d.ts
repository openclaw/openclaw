import type { PluginRecord } from "./registry.js";
import type { PluginSourceRoots } from "./roots.js";
export { resolvePluginSourceRoots } from "./roots.js";
export type { PluginSourceRoots } from "./roots.js";
export declare function formatPluginSourceForTable(plugin: Pick<PluginRecord, "source" | "origin">, roots: PluginSourceRoots): {
    value: string;
    rootKey?: keyof PluginSourceRoots;
};
