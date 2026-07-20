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
 * Best-effort removal of the canonical per-agent state parent directory after
 * agent/ and sessions/ subdirectories have been cleaned up.
 *
 * Only the default {@code <stateDir>/agents/<agentId>} root is eligible.
 * Custom agentDir values that resolve outside this root are preserved to
 * avoid removing unrelated user files.
 *
 * Uses {@code fs.promises.rmdir} so the removal is atomic: the OS refuses
 * with ENOTEMPTY when the directory has been repopulated between the
 * subdirectory cleanup and the parent removal (e.g. a same-id agent
 * recreation), which prevents accidental deletion of new session state.
 */
export async function removeEmptyAgentParentDir(params: {
  agentDir: string;
  agentId: string;
  stateDir: string;
}): Promise<void> {
  const canonicalRoot = path.resolve(params.stateDir, "agents", params.agentId);
  const actualParent = path.dirname(params.agentDir);
  // Only the canonical per-agent root may be removed; custom or configured
  // agentDir paths may have a parent containing unrelated user files.
  if (canonicalRoot !== actualParent) {
    return;
  }
  // rmdir is atomic and fails with ENOTEMPTY when the directory has content,
  // avoiding the check-to-use race of readdirSync + later recursive trash.
  try {
    await fs.promises.rmdir(canonicalRoot);
  } catch {
    // Best-effort: keep the directory if it is non-empty, missing, or the
    // filesystem rejects the operation.
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
