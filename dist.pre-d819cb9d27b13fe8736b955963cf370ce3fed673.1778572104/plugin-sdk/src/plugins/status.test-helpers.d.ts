import type { PluginLoadResult } from "./loader.js";
import type { PluginRecord } from "./registry.js";
import type { PluginCompatibilityNotice } from "./status.js";
import type { PluginHookName } from "./types.js";
export declare const LEGACY_BEFORE_AGENT_START_MESSAGE = "still uses legacy before_agent_start; keep regression coverage on this plugin, and prefer before_model_resolve/before_prompt_build for new work.";
export declare const HOOK_ONLY_MESSAGE = "is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet.";
export declare function createCompatibilityNotice(params: Pick<PluginCompatibilityNotice, "pluginId" | "code">): PluginCompatibilityNotice;
export declare function createPluginRecord(overrides: Partial<PluginRecord> & Pick<PluginRecord, "id">): PluginRecord;
export declare function createTypedHook(params: {
    pluginId: string;
    hookName: PluginHookName;
    source?: string;
}): PluginLoadResult["typedHooks"][number];
export declare function createCustomHook(params: {
    pluginId: string;
    events: string[];
    name?: string;
}): PluginLoadResult["hooks"][number];
export declare function createPluginLoadResult(overrides?: Partial<PluginLoadResult> & Pick<PluginLoadResult, "plugins">): PluginLoadResult;
