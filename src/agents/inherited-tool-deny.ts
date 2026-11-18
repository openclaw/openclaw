/**
 * Normalizes inherited tool allow/deny lists, the spawn's tool-policy source and ACP compatibility errors.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { SessionEntry } from "../config/sessions/types.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import { normalizeToolPolicyName } from "./tool-policy-shared.js";

const ACP_UNSUPPORTED_INHERITED_TOOL_DENY = [
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
] as const;

// Inherited allowlists are rebuilt from the effective OpenClaw tool surface.
// ACP-only aliases can appear in explicit deny policies, but not in that
// effective allowlist unless a plugin happens to expose matching tool names.
const ACP_REQUIRED_INHERITED_TOOL_ALLOW = [
  "apply_patch",
  "edit",
  "exec",
  "process",
  "read",
  "write",
] as const;

export function normalizeInheritedToolDenylist(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(
    value.flatMap((entry) => {
      const normalized = typeof entry === "string" ? normalizeToolPolicyName(entry) : "";
      return normalized ? [normalized] : [];
    }),
  );
}

export function inheritedToolDenyPatch(value: unknown): { inheritedToolDeny?: string[] } {
  const inheritedToolDeny = normalizeInheritedToolDenylist(value);
  return inheritedToolDeny.length > 0 ? { inheritedToolDeny } : {};
}

export function normalizeInheritedToolAllowlist(value: unknown): string[] {
  return normalizeInheritedToolDenylist(value);
}

export function inheritedToolAllowPatch(value: unknown): { inheritedToolAllow?: string[] } {
  const inheritedToolAllow = normalizeInheritedToolAllowlist(value);
  return inheritedToolAllow.length > 0 ? { inheritedToolAllow } : {};
}

/** A spawn's tool-policy source; a scheduled-run mark is persisted only with the run it names. */
export function inheritedToolPolicySourcePatch(input: {
  inheritedToolPolicySource?: "sender" | "scheduled-run";
  inheritedToolPolicyRunSessionKey?: string;
}): Pick<SessionEntry, "inheritedToolPolicySource" | "inheritedToolPolicyRunSessionKey"> {
  if (input.inheritedToolPolicySource === "sender") {
    return { inheritedToolPolicySource: "sender" };
  }
  return input.inheritedToolPolicySource === "scheduled-run" &&
    input.inheritedToolPolicyRunSessionKey
    ? {
        inheritedToolPolicySource: "scheduled-run",
        inheritedToolPolicyRunSessionKey: input.inheritedToolPolicyRunSessionKey,
      }
    : {};
}

export function findAcpUnsupportedInheritedToolDeny(value: unknown): string | undefined {
  const inheritedToolDeny = normalizeInheritedToolDenylist(value);
  if (inheritedToolDeny.length === 0) {
    return undefined;
  }
  const matches = createToolPolicyMatcher({ deny: inheritedToolDeny });
  return ACP_UNSUPPORTED_INHERITED_TOOL_DENY.find((toolName) => !matches(toolName));
}

export function findAcpUnsupportedInheritedToolAllow(value: unknown): string | undefined {
  const inheritedToolAllow = normalizeInheritedToolAllowlist(value);
  if (inheritedToolAllow.length === 0) {
    return undefined;
  }
  const matches = createToolPolicyMatcher({ allow: inheritedToolAllow });
  return ACP_REQUIRED_INHERITED_TOOL_ALLOW.find((toolName) => !matches(toolName));
}

export function formatAcpInheritedToolDenyError(toolName: string): string {
  return `runtime="acp" is unavailable because the requester denies ${toolName}. Use runtime="subagent".`;
}

export function formatAcpInheritedToolAllowError(toolName: string): string {
  return `runtime="acp" is unavailable because the requester does not allow ${toolName}. Use runtime="subagent".`;
}
