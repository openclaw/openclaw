import { listActiveAcpSessionsForOwner } from "../../../acp/control-plane/active-turns.js";
import { getSubagentRunByChildSessionKey } from "../registry/subagent-registry-read.js";

export function countUntrackedActiveAcpRunsForOwner(
  ownerKey: string | undefined,
  pendingChildSessionKeys?: ReadonlySet<string>,
): number {
  if (!ownerKey?.trim()) {
    return 0;
  }
  return new Set(
    listActiveAcpSessionsForOwner(ownerKey.trim()).filter((sessionKey) => {
      const run = getSubagentRunByChildSessionKey(sessionKey);
      return (
        !pendingChildSessionKeys?.has(sessionKey) &&
        !(run && typeof run.execution.endedAt !== "number")
      );
    }),
  ).size;
}
