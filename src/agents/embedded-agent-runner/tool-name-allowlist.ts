import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { ClientToolDefinition } from "../command/shared-types.js";
import type { AgentTool } from "../runtime/index.js";
import { normalizeToolPolicyName } from "../tool-policy-shared.js";

/**
 * OpenClaw built-in tools that remain present in the embedded runtime even when
 * OpenClaw routes execution through custom tool definitions.
 */
export const AGENT_RESERVED_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];

export const CLIENT_TOOL_NAME_CONFLICT_PREFIX = "client tool name conflict:";

export function findClientToolNameConflicts(params: {
  tools: ClientToolDefinition[];
  existingToolNames?: Iterable<string>;
}): string[] {
  const existingNormalized = new Set<string>();
  for (const name of params.existingToolNames ?? []) {
    const trimmed = name.trim();
    if (trimmed) {
      existingNormalized.add(normalizeToolPolicyName(trimmed));
    }
  }

  const conflicts = new Set<string>();
  const seenClientNames = new Map<string, string>();
  for (const tool of params.tools) {
    const rawName = (tool.function?.name ?? "").trim();
    if (!rawName) {
      continue;
    }
    const normalizedName = normalizeToolPolicyName(rawName);
    if (existingNormalized.has(normalizedName)) {
      conflicts.add(rawName);
    }
    const priorClientName = seenClientNames.get(normalizedName);
    if (priorClientName) {
      conflicts.add(priorClientName);
      conflicts.add(rawName);
      continue;
    }
    seenClientNames.set(normalizedName, rawName);
  }
  return Array.from(conflicts);
}

/** Detect client tool conflict errors without depending on object identity. */
export function isClientToolNameConflictError(err: unknown): err is Error {
  return err instanceof Error && err.message.startsWith(CLIENT_TOOL_NAME_CONFLICT_PREFIX);
}

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
  // oxlint-disable-next-line unicorn/no-array-sort -- The materialized set array is private.
  return [...new Set(allowedToolNames)].sort((a, b) => a.localeCompare(b));
}
