import type { AgentMessage } from "@mariozechner/pi-agent-core";
export { isRedactedSessionsSpawnAttachment } from "./tool-call-shared.js";
declare function makeMissingToolResult(params: {
    toolCallId: string;
    toolName?: string;
    text?: string;
}): Extract<AgentMessage, {
    role: "toolResult";
}>;
export { makeMissingToolResult };
export type ToolCallInputRepairReport = {
    messages: AgentMessage[];
    droppedToolCalls: number;
    droppedAssistantMessages: number;
};
export type ToolCallInputRepairOptions = {
    allowedToolNames?: Iterable<string>;
    allowProviderOwnedThinkingReplay?: boolean;
};
export type ErroredAssistantResultPolicy = "preserve" | "drop";
export type ToolUseResultPairingOptions = {
    erroredAssistantResultPolicy?: ErroredAssistantResultPolicy;
    missingToolResultText?: string;
};
export declare function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[];
export declare function repairToolCallInputs(messages: AgentMessage[], options?: ToolCallInputRepairOptions): ToolCallInputRepairReport;
export declare function sanitizeToolCallInputs(messages: AgentMessage[], options?: ToolCallInputRepairOptions): AgentMessage[];
export declare function sanitizeToolUseResultPairing(messages: AgentMessage[], options?: ToolUseResultPairingOptions): AgentMessage[];
export type ToolUseRepairReport = {
    messages: AgentMessage[];
    added: Array<Extract<AgentMessage, {
        role: "toolResult";
    }>>;
    droppedDuplicateCount: number;
    droppedOrphanCount: number;
    moved: boolean;
};
export declare function repairToolUseResultPairing(messages: AgentMessage[], options?: ToolUseResultPairingOptions): ToolUseRepairReport;
