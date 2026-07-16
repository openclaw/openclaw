/** Safety checks for deleting agents whose workspaces may overlap other agents. */
import fs from "node:fs";
import path from "node:path";
import { lowercasePreservingWhitespace } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveAgentWorkspaceDir } from "./agent-scope.js";

function normalizeWorkspacePathForComparison(input: string): string {
  const resolved = path.resolve(input.replaceAll("\0", ""));
  let normalized = resolved;
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Keep lexical path for non-existent directories.
  }
  if (process.platform === "win32") {
    return lowercasePreservingWhitespace(normalized);
  }
  return normalized;
}

function workspacePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspacePathForComparison(left);
  const normalizedRight = normalizeWorkspacePathForComparison(right);
  return (
    isPathInside(normalizedRight, normalizedLeft) || isPathInside(normalizedLeft, normalizedRight)
  );
}

/**
 * Returns true when the canonical per-agent state parent directory should be
 * removed after deleting the agent/ and sessions/ subdirectories.
 *
 * Only the default {@code <stateDir>/agents/<agentId>} root is eligible.
 * Custom agentDir values that resolve outside this root are preserved to
 * avoid removing unrelated user files. The directory must also be empty after
 * subdirectories have been trashed; a non-empty parent is left in place.
 */
export function shouldRemoveEmptyAgentParentDir(params: {
  agentDir: string;
  agentId: string;
  stateDir: string;
}): boolean {
  const canonicalRoot = path.resolve(params.stateDir, "agents", params.agentId);
  const actualParent = path.dirname(params.agentDir);
  // Only the canonical per-agent root may be removed; custom or configured
  // agentDir paths may have a parent containing unrelated user files.
  if (canonicalRoot !== actualParent) {
    return false;
  }
  // Guard against deleting a directory with unexpected remaining content.
  try {
    return fs.readdirSync(canonicalRoot).length === 0;
  } catch {
    return false;
  }
}

/** Lists other agents whose workspaces overlap a candidate delete target. */
export function findOverlappingWorkspaceAgentIds(
  cfg: OpenClawConfig,
  agentId: string,
  workspaceDir: string,
): string[] {
  const entries = listAgentEntries(cfg);
  const normalizedAgentId = normalizeAgentId(agentId);
  const overlappingAgentIds: string[] = [];
  for (const entry of entries) {
    const otherAgentId = normalizeAgentId(entry.id);
    if (otherAgentId === normalizedAgentId) {
      continue;
    }
    const otherWorkspace = resolveAgentWorkspaceDir(cfg, otherAgentId);
    if (workspacePathsOverlap(workspaceDir, otherWorkspace)) {
      overlappingAgentIds.push(otherAgentId);
    }
  }
  return overlappingAgentIds;
}
