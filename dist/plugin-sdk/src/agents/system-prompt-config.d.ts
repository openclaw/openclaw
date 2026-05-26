import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";
type AgentSystemPromptRenderParams = Parameters<typeof buildAgentSystemPrompt>[0];
export type ResolvedAgentSystemPromptConfig = Pick<AgentSystemPromptRenderParams, "ownerDisplay" | "ownerDisplaySecret" | "subagentDelegationMode" | "ttsHint" | "modelAliasLines" | "memoryCitationsMode">;
export type ConfiguredAgentSystemPromptParams = AgentSystemPromptRenderParams & {
    config?: OpenClawConfig;
    agentId?: string;
};
export declare function resolveAgentSystemPromptConfig(params: {
    config?: OpenClawConfig;
    agentId?: string;
}): ResolvedAgentSystemPromptConfig;
export declare function buildConfiguredAgentSystemPrompt(params: ConfiguredAgentSystemPromptParams): string;
export {};
