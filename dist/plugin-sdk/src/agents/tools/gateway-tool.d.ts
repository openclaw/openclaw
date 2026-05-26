import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type AnyAgentTool } from "./common.js";
/** @internal Exposed for regression tests only; do not import from runtime code. */
export declare const ALLOWED_GATEWAY_CONFIG_PATHS_FOR_TEST: readonly ["agents.defaults.systemPromptOverride", "agents.defaults.promptOverlays", "agents.defaults.model", "agents.defaults.thinkingDefault", "agents.defaults.subagents.thinking", "agents.defaults.reasoningDefault", "agents.defaults.fastModeDefault", "agents.list[].id", "agents.list[].systemPromptOverride", "agents.list[].model", "agents.list[].thinkingDefault", "agents.list[].subagents.thinking", "agents.list[].reasoningDefault", "agents.list[].fastModeDefault", "channels.*.requireMention", "channels.*.*.requireMention", "channels.*.*.*.requireMention", "channels.*.*.*.*.requireMention", "channels.*.*.*.*.*.requireMention", "messages.visibleReplies", "messages.groupChat.visibleReplies"];
/** @internal Exposed for regression tests only; do not import from runtime code. */
export declare function assertGatewayConfigMutationAllowedForTest(params: {
    action: "config.apply" | "config.patch";
    currentConfig: Record<string, unknown>;
    raw: string;
}): void;
export declare function createGatewayTool(opts?: {
    agentSessionKey?: string;
    config?: OpenClawConfig;
}): AnyAgentTool;
