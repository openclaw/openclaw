import { listActiveAcpSessionsForOwner } from "../../../acp/control-plane/active-turns.js";
import { buildLatestSubagentSessionListReadIndex } from "../registry/subagent-registry-read.js";

export function countUntrackedActiveAcpRunsForOwner(
  ownerKey: string | undefined,
  pendingChildSessionKeys?: ReadonlySet<string>,
): number {
  if (!ownerKey?.trim()) {
    return 0;
  }
  const sessions = listActiveAcpSessionsForOwner(ownerKey.trim());
  const registry = buildLatestSubagentSessionListReadIndex(sessions);
  return new Set(
    sessions.filter((sessionKey) => {
      const run = registry.getLatestSubagentRun(sessionKey);
      return (
        !pendingChildSessionKeys?.has(sessionKey) &&
        !(run && typeof run.execution.endedAt !== "number")
      );
    }),
  ).size;
}
