import {
  buildAiSnapshotFromChromeMcpSnapshot,
  type ChromeMcpSnapshotNode,
} from "./chrome-mcp.snapshot.js";
// Route-facing Chrome MCP snapshot results preserve automatic truncation facts.
import type { RoleRefMap, RoleSnapshotOptions } from "./pw-role-snapshot.js";
import { appendRoleSnapshotDepthTruncationMarker } from "./snapshot-depth-limit.js";

export function buildChromeMcpRouteSnapshot(params: {
  root: ChromeMcpSnapshotNode;
  options?: RoleSnapshotOptions;
}): { snapshot: string; refs: RoleRefMap; truncated?: true } {
  const built = buildAiSnapshotFromChromeMcpSnapshot(params);
  return built.truncated
    ? {
        ...built,
        snapshot: appendRoleSnapshotDepthTruncationMarker(built.snapshot),
        truncated: true as const,
      }
    : built;
}
