import { listActiveAcpSessionsForOwner } from "../../../acp/control-plane/active-turns.js";
import { getSubagentSessionListRunByChildSessionKey } from "../registry/subagent-registry-read.js";

export function countUntrackedActiveAcpRunsForOwner(
  ownerKey: string | undefined,
  pendingChildSessionKeys?: ReadonlySet<string>,
): number {
  if (!ownerKey?.trim()) {
    return 0;
  }
  const sessions = listActiveAcpSessionsForOwner(ownerKey.trim());
  return new Set(
    sessions.filter((sessionKey) => {
      const run = getSubagentSessionListRunByChildSessionKey(sessionKey);
      return (
        !pendingChildSessionKeys?.has(sessionKey) &&
        !(run && typeof run.execution.endedAt !== "number")
      );
    }),
  ).size;
}
