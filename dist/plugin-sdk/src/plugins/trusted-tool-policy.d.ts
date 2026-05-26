import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult, PluginHookToolContext } from "./hook-types.js";
export declare function hasTrustedToolPolicies(): boolean;
export declare function runTrustedToolPolicies(event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext, options?: {
    config?: OpenClawConfig;
    deriveEvent?: (params: Record<string, unknown>) => Pick<PluginHookBeforeToolCallEvent, "derivedPaths">;
}): Promise<PluginHookBeforeToolCallResult | undefined>;
