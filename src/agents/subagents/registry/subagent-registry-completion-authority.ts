import { isDeepStrictEqual } from "node:util";
import type { TrustedAgentToolCaller } from "../../../gateway/server-methods/client-types.js";
import type { captureOperatorToolGatewayContinuationContext } from "../../../gateway/server-plugin-in-process-dispatch.js";
import { mergeAcceptedSessionSpawnsForRun } from "../../accepted-session-spawn.js";
import type { OperationalRunInstanceRef } from "../../admitted-run-context.js";
import { resolveRequesterPrincipalKey } from "../../requester-origin.js";
import { getGatewayToolCallerIdentity } from "../../tools/gateway-caller-context.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey, isSameSubagentRunOwner } from "./subagent-run-generation.js";

export type CompletionAuthority = NonNullable<
  Awaited<ReturnType<typeof captureOperatorToolGatewayContinuationContext>>
>;
export type CompletionCustody = {
  authority: CompletionAuthority;
  entry: SubagentRunRecord;
  originalSpawn?: { instance: OperationalRunInstanceRef; entry: SubagentRunRecord };
  stop: () => void;
};

export type CompletionAuthorityOwner = {
  runs: ReadonlyMap<string, SubagentRunRecord>;
  custodies: ReadonlyMap<object, CompletionCustody>;
  required: Pick<WeakMap<object, boolean>, "has" | "get">;
  currentValue(entry: SubagentRunRecord): SubagentRunRecord;
  assertCurrent(entry: SubagentRunRecord): void;
  isCancellationNotice(entry: SubagentRunRecord): boolean;
  runWithAuthority<T>(entry: SubagentRunRecord, run: () => T): T;
  runWithBatchAuthority<T>(entries: readonly SubagentRunRecord[], run: () => T): T;
};

/** Compatible current custody owns the entire observed batch, including cancellations. */
export function runCompletionBatchWithAuthority<T>(
  owner: CompletionAuthorityOwner,
  observed: readonly SubagentRunRecord[],
  run: () => T,
): T {
  const batch = observed.map((entry) => owner.currentValue(entry));
  batch.forEach((entry) => owner.assertCurrent(entry));
  const resultEntry = batch.find((entry) => !owner.isCancellationNotice(entry));
  if (!resultEntry) {
    const sources = batch.map(
      (entry) => owner.custodies.get(getSubagentRunRuntimeKey(entry))?.authority,
    );
    const first = sources[0];
    const original = first?.operatorAuthority;
    // A cancellation-only cohort can share its retained requester. Otherwise its
    // independently admitted cancellation caller still owns the notices.
    if (
      !first ||
      !original ||
      sources.some(
        (source) =>
          source?.operatorAuthority?.source !== original.source ||
          !isDeepStrictEqual(source?.operatorAuthority?.scopes, original.scopes),
      )
    ) {
      return run();
    }
    sources.forEach((source) => source?.assertCurrent());
    return first.run(run);
  }
  const firstCustody = owner.custodies.get(getSubagentRunRuntimeKey(resultEntry));
  const first = firstCustody?.authority.operatorAuthority;
  // Mixed waves must still prove the cancelled member's original source is live and identical.
  // A revoked or unrelated cancellation cannot borrow a successful sibling's authority.
  for (const entry of batch) {
    const custody = owner.custodies.get(getSubagentRunRuntimeKey(entry));
    if (owner.required.has(getSubagentRunRuntimeKey(entry)) && !custody) {
      throw new Error("Subagent completion authority is no longer active");
    }
    custody?.authority.assertCurrent();
    const source = custody?.authority.operatorAuthority;
    // Siblings re-admitted independently share durable input evidence, not an old capability.
    const sameRecoveredSource =
      owner.required.get(getSubagentRunRuntimeKey(resultEntry)) &&
      owner.required.get(getSubagentRunRuntimeKey(entry)) &&
      resultEntry.operatorRecoverySource !== undefined &&
      isDeepStrictEqual(resultEntry.operatorRecoverySource, entry.operatorRecoverySource);
    if (
      (!sameRecoveredSource && source?.source !== first?.source) ||
      !isDeepStrictEqual(source?.scopes, first?.scopes) ||
      !isDeepStrictEqual(custody?.authority.scopes, firstCustody?.authority.scopes)
    ) {
      throw new Error("Subagent completion batch has incompatible operator authority");
    }
  }
  return owner.runWithAuthority(resultEntry, run);
}

/** Only an original, fully accepted singleton may carry its selected requester. */
export async function runCompletionBatchWithRequester<T>(
  owner: CompletionAuthorityOwner,
  observed: readonly SubagentRunRecord[],
  run: (caller?: TrustedAgentToolCaller) => Promise<T>,
): Promise<T> {
  return owner.runWithBatchAuthority(observed, () => {
    const entry = observed.length === 1 ? owner.currentValue(observed[0]!) : undefined;
    const custody = entry && owner.custodies.get(getSubagentRunRuntimeKey(entry));
    const original = custody?.originalSpawn;
    const rearmGeneration = entry?.requesterSettleWake?.rearmGeneration;
    const isOriginalSingleton = () => {
      if (!entry || !original || rearmGeneration === undefined) {
        return false;
      }
      const current = owner.runs.get(entry.runId);
      const accepted = mergeAcceptedSessionSpawnsForRun(original.instance);
      const wake = current?.requesterSettleWake;
      return Boolean(
        current &&
        isSameSubagentRunOwner(current, entry) &&
        isSameSubagentRunOwner(current, original.entry) &&
        current.completionRequesterSessionId &&
        current.completionRequesterSessionId === original.entry.completionRequesterSessionId &&
        current.completionRequesterLifecycleRevision ===
          original.entry.completionRequesterLifecycleRevision &&
        current.requesterTurnRunId === undefined &&
        current.expectsCompletionMessage === true &&
        current.execution.status === "terminal" &&
        current.execution.outcome?.status === "ok" &&
        !current.collect &&
        !current.killIntent &&
        !current.killReconciliation &&
        !current.suppressCompletionDelivery &&
        // Completed terminal cleanup leaves this frozen wake owning its delivery.
        !current.retireAfterRequesterTurn &&
        !wake?.retireAfterSettle &&
        !wake?.pauseNotice &&
        wake?.requesterYieldBatch === true &&
        wake.rearmGeneration === rearmGeneration &&
        wake.batchRunIds?.length === 1 &&
        wake.batchRunIds[0] === current.runId &&
        accepted.length === 1 &&
        accepted[0]?.expectsCompletionMessage === true &&
        accepted[0].runId === (current.taskRunId ?? current.runId) &&
        accepted[0].childSessionKey === current.childSessionKey,
      );
    };
    if (!entry || !custody || !isOriginalSingleton()) {
      return run();
    }
    return custody.authority.runWithRequester(async () => {
      const caller = getGatewayToolCallerIdentity();
      if (
        !caller?.requesterOrigin ||
        caller.agentId !== entry.requesterAgentId ||
        caller.sessionKey !== entry.requesterSessionKey ||
        !resolveRequesterPrincipalKey({ requesterOrigin: caller.requesterOrigin })
      ) {
        return custody.authority.run(() => run());
      }
      const assertCurrent = () => {
        custody.authority.assertCurrent();
        owner.assertCurrent(entry);
        if (
          owner.custodies.get(getSubagentRunRuntimeKey(entry)) !== custody ||
          !isOriginalSingleton()
        ) {
          throw new Error("Original singleton requester completion owner changed");
        }
      };
      assertCurrent();
      return run({
        agentId: caller.agentId,
        sessionKey: caller.sessionKey,
        requesterOrigin: caller.requesterOrigin,
        assertCurrent,
      });
    });
  });
}
