import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
type AnyAgentTool = AgentTool;
export type ClientToolCallRecorder = ((toolName: string, params: Record<string, unknown>) => void) | {
    reserve?: (toolCallId: string, toolName: string) => void;
    complete: (toolCallId: string, toolName: string, params: Record<string, unknown>) => void;
    discard?: (toolCallId: string, toolName: string) => void;
};
export declare const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";
export declare function findClientToolNameConflicts(params: {
    tools: ClientToolDefinition[];
    existingToolNames?: Iterable<string>;
}): string[];
export declare function createClientToolNameConflictError(conflicts: string[]): Error;
export declare function isClientToolNameConflictError(err: unknown): err is Error;
export declare function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[];
export declare function toClientToolDefinitions(tools: ClientToolDefinition[], onClientToolCall?: ClientToolCallRecorder, hookContext?: HookContext): ToolDefinition[];
export {};
