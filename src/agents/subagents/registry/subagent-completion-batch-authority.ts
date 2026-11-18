import { isDeepStrictEqual } from "node:util";
import type { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import type { OperationalRunInstanceRef } from "../../admitted-run-context.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export type CompletionAuthority = NonNullable<
  Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
>;
export type CompletionCustody = {
  authority: CompletionAuthority;
  entry: SubagentRunRecord;
  /** The requester run whose accepted receipt this child's completion satisfies. */
  requesterRunInstance?: OperationalRunInstanceRef;
  stop: () => void;
};

export function isCancellationNotice(entry: SubagentRunRecord): boolean {
  return (
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.execution.outcome?.status === "error"
  );
}

export function hasSameCompletionAuthority(
  entry: SubagentRunRecord,
  anchor: SubagentRunRecord,
  custody: CompletionCustody | undefined,
  firstCustody: CompletionCustody | undefined,
): boolean {
  const source = custody?.authority.operatorAuthority;
  const first = firstCustody?.authority.operatorAuthority;
  const instance = custody?.requesterRunInstance?.instanceId;
  const firstInstance = firstCustody?.requesterRunInstance?.instanceId;
  // Restored children independently reauthorize the same saved requester turn.
  const sameRecovery =
    entry.operatorRecoverySource !== undefined &&
    isDeepStrictEqual(entry.operatorRecoverySource, anchor.operatorRecoverySource) &&
    isDeepStrictEqual(source?.recoverySnapshot, first?.recoverySnapshot);
  return (
    (instance === firstInstance || ((!instance || !firstInstance) && sameRecovery)) &&
    (source?.source === first?.source || sameRecovery) &&
    source?.profileId === first?.profileId &&
    isDeepStrictEqual(source?.scopes, first?.scopes)
  );
}
