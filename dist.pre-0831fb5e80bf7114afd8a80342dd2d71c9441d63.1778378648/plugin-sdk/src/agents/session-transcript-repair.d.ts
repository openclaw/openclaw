import type { AgentMessage } from "@mariozechner/pi-agent-core";
declare function makeMissingToolResult(params: {
    toolCallId: string;
    toolName?: string;
    text?: string;
}): Extract<AgentMessage, {
    role: "toolResult";
}>;
export { makeMissingToolResult };
type ToolCallInputRepairOptions = {
    allowedToolNames?: Iterable<string>;
    allowProviderOwnedThinkingReplay?: boolean;
};
type ErroredAssistantResultPolicy = "preserve" | "drop";
type ToolUseResultPairingOptions = {
    erroredAssistantResultPolicy?: ErroredAssistantResultPolicy;
    missingToolResultText?: string;
};
export declare function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[];
export declare function sanitizeToolCallInputs(messages: AgentMessage[], options?: ToolCallInputRepairOptions): AgentMessage[];
export declare function sanitizeToolUseResultPairing(messages: AgentMessage[], options?: ToolUseResultPairingOptions): AgentMessage[];
type ToolUseRepairReport = {
    messages: AgentMessage[];
    added: Array<Extract<AgentMessage, {
        role: "toolResult";
    }>>;
    droppedDuplicateCount: number;
    droppedOrphanCount: number;
    moved: boolean;
};
export declare function repairToolUseResultPairing(messages: AgentMessage[], options?: ToolUseResultPairingOptions): ToolUseRepairReport;
