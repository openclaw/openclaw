import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { AgentTool } from "../runtime/index.js";
import type { ClientToolDefinition } from "./run/params.js";

/**
 * OpenClaw built-in tools that remain present in the embedded runtime even when
 * OpenClaw routes execution through custom tool definitions.
 */
export const AGENT_RESERVED_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  return new Set([
    ...collectRegisteredToolNames(params.tools),
    ...normalizeTrimmedStringList(params.clientTools?.map((tool) => tool.function?.name)),
  ]);
}

export function collectRegisteredToolNames(tools: Array<{ name?: string }>): Set<string> {
  return new Set(normalizeTrimmedStringList(tools.map((tool) => tool.name)));
}

export function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[] {
  return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
