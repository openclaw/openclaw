import { expandToolGroups, normalizeToolName } from "./tool-policy-shared.js";

const ACP_UNSUPPORTED_INHERITED_TOOL_DENY = new Set([
  "apply_patch",
  "edit",
  "exec",
  "fs_delete",
  "fs_move",
  "fs_write",
  "process",
  "read",
  "shell",
  "spawn",
  "write",
]);

export function normalizeInheritedToolDenylist(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const normalized = normalizeToolName(entry);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function inheritedToolDenyPatch(value: unknown): { inheritedToolDeny?: string[] } {
  const inheritedToolDeny = normalizeInheritedToolDenylist(value);
  return inheritedToolDeny.length > 0 ? { inheritedToolDeny } : {};
}

export function findAcpUnsupportedInheritedToolDeny(value: unknown): string | undefined {
  return expandToolGroups(normalizeInheritedToolDenylist(value)).find((tool) =>
    ACP_UNSUPPORTED_INHERITED_TOOL_DENY.has(tool),
  );
}

export function formatAcpInheritedToolDenyError(toolName: string): string {
  return `runtime="acp" is unavailable because the requester denies ${toolName}. Use runtime="subagent".`;
}
