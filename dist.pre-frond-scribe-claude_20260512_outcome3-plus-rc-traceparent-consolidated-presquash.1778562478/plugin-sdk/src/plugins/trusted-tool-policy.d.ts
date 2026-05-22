import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult, PluginHookToolContext } from "./hook-types.js";
export declare function runTrustedToolPolicies(event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext, options?: {
    config?: OpenClawConfig;
}): Promise<PluginHookBeforeToolCallResult | undefined>;
