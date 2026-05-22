import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { LlmCompleteCaller, PluginRuntimeCore, RuntimeLogger } from "./types-core.js";
export type RuntimeLlmAuthority = {
    caller?: LlmCompleteCaller;
    /** Trusted host-derived plugin id used only for config policy lookup. */
    pluginIdForPolicy?: string;
    sessionKey?: string;
    agentId?: string;
    requiresBoundAgent?: boolean;
    allowAgentIdOverride?: boolean;
    allowModelOverride?: boolean;
    allowedModels?: readonly string[];
    allowComplete?: boolean;
    denyReason?: string;
};
export type CreateRuntimeLlmOptions = {
    getConfig?: () => OpenClawConfig | undefined;
    authority?: RuntimeLlmAuthority;
    logger?: RuntimeLogger;
};
/**
 * Create the host-owned generic LLM completion runtime for trusted plugin callers.
 */
export declare function createRuntimeLlm(options?: CreateRuntimeLlmOptions): PluginRuntimeCore["llm"];
