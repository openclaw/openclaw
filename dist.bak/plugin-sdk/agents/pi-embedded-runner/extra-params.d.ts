import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
/**
 * Resolve provider-specific extra params from model config.
 * Used to pass through stream params like temperature/maxTokens.
 *
 * @internal Exported for testing only
 */
export declare function resolveExtraParams(params: {
    cfg: OpenClawConfig | undefined;
    provider: string;
    modelId: string;
    agentId?: string;
}): Record<string, unknown> | undefined;
/**
 * Apply extra params (like temperature) to an agent's streamFn.
 * Also adds OpenRouter app attribution headers when using the OpenRouter provider.
 *
 * @internal Exported for testing
 */
export declare function applyExtraParamsToAgent(agent: {
    streamFn?: StreamFn;
}, cfg: OpenClawConfig | undefined, provider: string, modelId: string, extraParamsOverride?: Record<string, unknown>, thinkingLevel?: ThinkLevel, agentId?: string): void;
