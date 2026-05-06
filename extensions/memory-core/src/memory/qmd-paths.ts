import path from "node:path";
import {
  encodeUserSegment,
  type MemoryPathEncodingMode,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

/**
 * Resolve the per-(agent, user) state directory for QMD.
 *
 * Without `userId`, returns the legacy agent-only layout. With a `userId`,
 * returns `<stateDir>/agents/<agentId>/users/<encoded-userId>` so that data
 * for distinct users lives in disjoint subtrees on disk.
 *
 * The userId is encoded via the shared path-encoding helper so that arbitrary
 * input (including traversal sequences and control characters) cannot escape
 * the agent directory.
 */
export function resolveQmdAgentDir(params: {
  stateDir: string;
  agentId: string;
  userId?: string;
  encoding?: MemoryPathEncodingMode;
}): string {
  const agentBase = path.join(params.stateDir, "agents", params.agentId);
  if (!params.userId) {
    return agentBase;
  }
  const segment = encodeUserSegment(params.userId, params.encoding ?? "hash");
  return path.join(agentBase, "users", segment);
}
