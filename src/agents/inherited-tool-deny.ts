import { normalizeToolName } from "./tool-policy-shared.js";

const MAX_INHERITED_TOOL_DENY_ENTRIES = 128;

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
    if (result.length >= MAX_INHERITED_TOOL_DENY_ENTRIES) {
      break;
    }
  }
  return result;
}

export function inheritedToolDenyPatch(value: unknown): { inheritedToolDeny?: string[] } {
  const inheritedToolDeny = normalizeInheritedToolDenylist(value);
  return inheritedToolDeny.length > 0 ? { inheritedToolDeny } : {};
}
