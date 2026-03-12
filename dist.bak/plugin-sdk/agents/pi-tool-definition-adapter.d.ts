import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ClientToolDefinition } from "./pi-embedded-runner/run/params.js";
import type { HookContext } from "./pi-tools.before-tool-call.js";
type AnyAgentTool = AgentTool;
export declare function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[];
export declare function toClientToolDefinitions(tools: ClientToolDefinition[], onClientToolCall?: (toolName: string, params: Record<string, unknown>) => void, hookContext?: HookContext): ToolDefinition[];
export {};
