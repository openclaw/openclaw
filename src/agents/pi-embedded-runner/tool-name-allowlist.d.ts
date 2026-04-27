import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ClientToolDefinition } from "./run/params.js";
/**
 * Pi built-in tools that remain present in the embedded runtime even when
 * OpenClaw routes execution through custom tool definitions.
 */
export declare const PI_RESERVED_TOOL_NAMES: string[];
export declare function collectAllowedToolNames(params: {
    tools: AgentTool[];
    clientTools?: ClientToolDefinition[];
}): Set<string>;
/**
 * Collect the exact tool names registered with Pi for this session.
 */
export declare function collectRegisteredToolNames(tools: Array<{
    name?: string;
}>): Set<string>;
export declare function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[];
