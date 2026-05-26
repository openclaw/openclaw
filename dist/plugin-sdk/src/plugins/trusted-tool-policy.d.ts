import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginHookBeforeToolCallEvent, PluginHookBeforeToolCallResult, PluginHookToolContext } from "./hook-types.js";
export declare function hasTrustedToolPolicies(): boolean;
export declare function runTrustedToolPolicies(event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext, options?: {
    config?: OpenClawConfig;
    deriveEvent?: (params: Record<string, unknown>) => Pick<PluginHookBeforeToolCallEvent, "derivedPaths">;
    normalizeEvent?: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => {
        params?: Record<string, unknown>;
        event?: Pick<PluginHookBeforeToolCallEvent, "toolKind" | "toolInputKind">;
        ctx?: Pick<PluginHookToolContext, "toolKind" | "toolInputKind">;
    } | undefined;
}): Promise<PluginHookBeforeToolCallResult | undefined>;
