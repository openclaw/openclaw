import { isDeepStrictEqual } from "node:util";
import {
  getCanonicalGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
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
export function assertRequiredCompletionCustody(
  entry: SubagentRunRecord,
  custody: SubagentCompletionCustody["authority"] | undefined,
): void {
  if (entry.requiresCompletionAuthority) {
    if (!custody?.operatorAuthority?.participationCeiling) {
      throw new Error("Constrained completion requires current original-source custody.");
    }
    custody.signal.throwIfAborted();
    custody.assertCurrent();
  }
}

function sameCompletionAuthority(
  first: SubagentCompletionCustody["authority"] | undefined,
  source: SubagentCompletionCustody["authority"] | undefined,
): boolean {
  return (
    source?.operatorAuthority?.source === first?.operatorAuthority?.source &&
    source?.operatorAuthority?.invocation === first?.operatorAuthority?.invocation &&
    isDeepStrictEqual(
      source?.operatorAuthority?.participationCeiling,
      first?.operatorAuthority?.participationCeiling,
    ) &&
    isDeepStrictEqual(source?.operatorAuthority?.scopes, first?.operatorAuthority?.scopes) &&
    isDeepStrictEqual(source?.scopes, first?.scopes)
  );
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
      sameCompletionAuthority(first, source)
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
    assertRequiredCompletionCustody(
      entry,
      custodies.get(getSubagentRunRuntimeKey(entry))?.authority,
    );
  });
  const resultEntry = batch.find((entry) => !isSubagentCancellationNotice(entry));
  const anchor = resultEntry ?? batch[0];
  const first = anchor && custodies.get(getSubagentRunRuntimeKey(anchor))?.authority;
  const sources = batch.map((entry) => custodies.get(getSubagentRunRuntimeKey(entry))?.authority);
  // Cancellation notices need an operator source; ordinary results can retain
  // source-less Gateway custody. Neither path may mix participant restrictions.
  const shared =
    first !== undefined &&
    (resultEntry !== undefined || first.operatorAuthority !== undefined) &&
    sources.every(
      (source) => source?.signal.aborted === false && sameCompletionAuthority(first, source),
    );
  if (!shared) {
    if (sources.some((source) => source?.operatorAuthority?.participationCeiling)) {
      throw new Error("Participant completion custody must stay current and separate.");
    }
    return run();
  }
  if (resultEntry) {
    return params.runWithAuthority(resultEntry, run);
  }
  sources.forEach((source) => source?.assertCurrent());
  return first.run(run);
}
