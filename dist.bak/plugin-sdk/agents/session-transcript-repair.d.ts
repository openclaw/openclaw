import type { AgentMessage } from "@mariozechner/pi-agent-core";
declare function makeMissingToolResult(params: {
    toolCallId: string;
    toolName?: string;
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
};
export declare function stripToolResultDetails(messages: AgentMessage[]): AgentMessage[];
export declare function repairToolCallInputs(messages: AgentMessage[], options?: ToolCallInputRepairOptions): ToolCallInputRepairReport;
export declare function sanitizeToolCallInputs(messages: AgentMessage[], options?: ToolCallInputRepairOptions): AgentMessage[];
export declare function sanitizeToolUseResultPairing(messages: AgentMessage[]): AgentMessage[];
export type ToolUseRepairReport = {
    messages: AgentMessage[];
    added: Array<Extract<AgentMessage, {
        role: "toolResult";
    }>>;
    droppedDuplicateCount: number;
    droppedOrphanCount: number;
    moved: boolean;
};
export declare function repairToolUseResultPairing(messages: AgentMessage[]): ToolUseRepairReport;
