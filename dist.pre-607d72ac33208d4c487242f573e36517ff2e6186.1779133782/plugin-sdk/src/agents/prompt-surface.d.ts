import type { AgentPromptSurfaceKind } from "../plugins/types.js";
export type AgentPromptRenderContext = {
    surface: AgentPromptSurfaceKind;
    agentRuntimeId?: string;
    backendKind?: string;
    availableTools?: ReadonlySet<string>;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    acpEnabled?: boolean;
    runtimeChannel?: string;
    runtimeCapabilities?: readonly string[];
};
export declare function buildOpenClawToolFallbackText(params: {
    surface: AgentPromptSurfaceKind;
    execToolName: string;
    processToolName: string;
}): string;
export declare function shouldRenderOpenClawToolWorkflowHints(params: {
    surface: AgentPromptSurfaceKind;
    hasToolList: boolean;
}): boolean;
export declare function resolveAgentPromptSurfaceForSessionKey(sessionKey?: string): AgentPromptSurfaceKind;
