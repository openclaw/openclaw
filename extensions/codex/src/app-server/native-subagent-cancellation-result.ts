import type {
  KnownChild,
  NativeDescendantCancellationResult,
  ParentState,
} from "./native-subagent-monitor-types.js";

/** Join registration settlement before judging the reserved cancellation's final result. */
export async function collectNativeCancellationResult(params: {
  results: PromiseSettledResult<NativeDescendantCancellationResult>[];
  registrations: Promise<PromiseSettledResult<void>[]>;
  assertCurrent: () => void;
  children: ReadonlyMap<string, KnownChild>;
  parents: readonly ParentState[];
  hasLateAdmission: () => boolean;
}): Promise<NativeDescendantCancellationResult> {
  const registrations = await params.registrations;
  const failed = [...params.results, ...registrations].flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  try {
    params.assertCurrent();
  } catch (error) {
    failed.push(error);
  }
  const pending = [...params.children.values()].some(
    (known) =>
      params.parents.includes(known.parent) &&
      known.pendingTurns.some((turn) => {
        const owner = turn.modelSource?.owner ?? turn.admittedOwner;
        return owner?.descendantsCancelled && turn.state !== "completed" && turn.state !== "failed";
      }),
  );
  if (params.hasLateAdmission() || pending) {
    failed.push(new Error("Codex descendant admission remains unsettled after cancellation"));
  }
  return params.results.reduce<NativeDescendantCancellationResult>(
    (total, result) => {
      if (result.status === "fulfilled") {
        total.killed += result.value.killed;
        total.cancelledRequesters.push(...result.value.cancelledRequesters);
      }
      return total;
    },
    { killed: 0, cancelledRequesters: [], ...(failed.length ? { errors: failed } : {}) },
  );
}
