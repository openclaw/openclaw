import { isDeepStrictEqual } from "node:util";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { intersectParticipationCeilings } from "../../participation-ceiling.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import type { SubagentCompletionCustody } from "./subagent-registry-memory.types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { getSubagentRunRuntimeKey } from "./subagent-run-generation.js";

export function isSubagentCancellationNotice(entry: SubagentRunRecord): boolean {
  return (
    entry.endedReason === SUBAGENT_ENDED_REASON_KILLED &&
    entry.execution.outcome?.status === "error"
  );
}

/** Durable child lineage cannot fall back to owner/System authority after custody loss. */
export function assertParticipationCompletionCustody(
  entry: SubagentRunRecord,
  custody: SubagentCompletionCustody["authority"] | undefined,
): void {
  if (entry.participationCeiling) {
    const current = custody?.operatorAuthority?.participationCeiling;
    if (!current) {
      throw new Error("Participant completion requires current original-source custody.");
    }
    intersectParticipationCeilings(entry.participationCeiling, current);
    custody.assertCurrent();
  }
}

/** Separate requester turns before admission; a sibling never supplies another invocation's authority. */
export function selectCompletionAuthorityBatch(
  observed: readonly SubagentRunRecord[],
  anchor: SubagentRunRecord,
  custodies: ReadonlyMap<object, SubagentCompletionCustody>,
  retired: WeakSet<object>,
): SubagentRunRecord[] {
  const first = custodies.get(getSubagentRunRuntimeKey(anchor))?.authority;
  const anchorResolver = getGatewayContextResolver(anchor);
  const gateway = anchorResolver && getCanonicalGatewayContextResolver(anchorResolver);
  const isRetired = retired.has(getSubagentRunRuntimeKey(anchor));
  return observed.filter((entry) => {
    const source = custodies.get(getSubagentRunRuntimeKey(entry))?.authority;
    const resolver = getGatewayContextResolver(entry);
    return (
      retired.has(getSubagentRunRuntimeKey(entry)) === isRetired &&
      (resolver && getCanonicalGatewayContextResolver(resolver)) === gateway &&
      source?.operatorAuthority?.source === first?.operatorAuthority?.source &&
      source?.operatorAuthority?.invocation === first?.operatorAuthority?.invocation &&
      isDeepStrictEqual(
        source?.operatorAuthority?.participationCeiling,
        first?.operatorAuthority?.participationCeiling,
      ) &&
      isDeepStrictEqual(source?.operatorAuthority?.scopes, first?.operatorAuthority?.scopes) &&
      isDeepStrictEqual(source?.scopes, first?.scopes)
    );
  });
}

/** The registry remains the custody owner; this policy only admits its current batch. */
export function runWithSubagentCompletionBatchAuthority<T>(
  params: {
    batch: readonly SubagentRunRecord[];
    custodies: ReadonlyMap<object, SubagentCompletionCustody>;
    assertCurrent: (entry: SubagentRunRecord) => void;
    runWithAuthority: (entry: SubagentRunRecord, run: () => T) => T;
  },
  run: () => T,
): T {
  const { batch, custodies } = params;
  batch.forEach((entry) => {
    params.assertCurrent(entry);
    assertParticipationCompletionCustody(
      entry,
      custodies.get(getSubagentRunRuntimeKey(entry))?.authority,
    );
  });
  const resultEntry = batch.find((entry) => !isSubagentCancellationNotice(entry));
  if (!resultEntry) {
    const sources = batch.map((entry) => custodies.get(getSubagentRunRuntimeKey(entry))?.authority);
    const first = sources[0];
    const original = first?.operatorAuthority;
    // A cancellation-only cohort can share its retained requester. Otherwise its
    // independently admitted cancellation caller still owns the notices.
    if (
      !first ||
      !original ||
      sources.some(
        (source) =>
          source?.signal.aborted !== false ||
          source.operatorAuthority?.source !== original.source ||
          source?.operatorAuthority?.invocation !== original.invocation ||
          !isDeepStrictEqual(source?.operatorAuthority?.scopes, original.scopes),
      )
    ) {
      return run();
    }
    sources.forEach((source) => source?.assertCurrent());
    return first.run(run);
  }
  const firstCustody = custodies.get(getSubagentRunRuntimeKey(resultEntry));
  const first = firstCustody?.authority.operatorAuthority;
  // Missing, revoked or mixed custody runs at the System baseline instead of
  // refusing the result; a sibling never supplies another member's authority.
  const shared = batch.every((entry) => {
    const custody = custodies.get(getSubagentRunRuntimeKey(entry));
    const source = custody?.authority.operatorAuthority;
    return (
      custody !== undefined &&
      !custody.authority.signal.aborted &&
      source?.source === first?.source &&
      source?.invocation === first?.invocation &&
      isDeepStrictEqual(source?.participationCeiling, first?.participationCeiling) &&
      isDeepStrictEqual(source?.scopes, first?.scopes) &&
      isDeepStrictEqual(custody.authority.scopes, firstCustody?.authority.scopes)
    );
  });
  if (
    !shared &&
    batch.some(
      (entry) =>
        custodies.get(getSubagentRunRuntimeKey(entry))?.authority.operatorAuthority
          ?.participationCeiling,
    )
  ) {
    throw new Error("Participant completion custody must stay current and separate.");
  }
  return shared ? params.runWithAuthority(resultEntry, run) : run();
}
