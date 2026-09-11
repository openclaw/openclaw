type CurrentTurnReplyCompletion = "pending" | "confirmed" | "ambiguous";

const completions = new WeakMap<
  object,
  { value?: CurrentTurnReplyCompletion; admission?: object }
>();
const activeOwners = new WeakSet<object>();

/** Private, attempt-owned receipt. Public result fields cannot mint this fact. */
export function createCurrentTurnReplyCompletionOwner(source?: object): object {
  const owner = Object.freeze({});
  activeOwners.add(owner);
  completions.set(owner, (source && completions.get(source)) || {});
  return owner;
}

export function closeCurrentTurnReplyCompletionOwner(owner: object): void {
  activeOwners.delete(owner);
}

/** An admitted send may settle after cleanup; a new send cannot acquire the closed owner. */
export function beginCurrentTurnReplyCompletion(
  owner: object | undefined,
): ((completion: CurrentTurnReplyCompletion | undefined) => void) | undefined {
  const receipt = owner && activeOwners.has(owner) ? completions.get(owner) : undefined;
  if (!receipt || receipt.admission || receipt.value) {
    return undefined;
  }
  // Permission refresh rebuilds tools, not the turn. Reserve before any awaited
  // preparation, without claiming that the adapter has received a dispatch.
  const admission = {};
  receipt.admission = admission;
  return (completion) => {
    if (
      receipt.admission !== admission ||
      (receipt.value !== undefined && receipt.value !== "pending")
    ) {
      return;
    }
    receipt.value = completion;
    if (completion === undefined) {
      // Only this admission may release proven non-dispatch. Retained callbacks
      // must not publish into a later admission after that release.
      delete receipt.admission;
    }
  };
}

export function readCurrentTurnReplyCompletion(
  source: unknown,
): CurrentTurnReplyCompletion | undefined {
  return source && typeof source === "object" ? completions.get(source)?.value : undefined;
}

/** Only core projections transfer the private receipt; object spreads cannot. */
export function copyCurrentTurnReplyCompletion<T>(source: unknown, target: T): T {
  const receipt = source && typeof source === "object" ? completions.get(source) : undefined;
  if (receipt && target && typeof target === "object") {
    completions.set(target, receipt);
  }
  return target;
}
