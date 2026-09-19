import type { EmbeddedRunTrigger } from "./run-trigger.js";

export type ReplyExpectation = "required" | "optional";
export type ReplyDeliveryState = "delivered" | "pending" | "missing";
export type ReplyDeliveryObserver = (
  minimumAssistantMessageIndex?: number,
) => Promise<ReplyDeliveryState>;
type ReplyCompletionEvidence = "ready" | "delivered" | "pending" | "blocked" | "empty";

/** Model output cannot waive a required reply. Only the input owner selects expectation. */
export type ReplyCompletion =
  | {
      readonly expectation: "required";
      readonly outcome: Exclude<ReplyCompletionEvidence, "empty"> | "missing";
    }
  | {
      readonly expectation: "optional";
      readonly outcome: Exclude<ReplyCompletionEvidence, "empty"> | "silent";
    };

/** Resolve legacy runtime inputs once; explicit host requiredness always wins. */
export function resolveReplyExpectation(params: {
  terminalReplyExpectation?: ReplyExpectation;
  allowEmptyAssistantReplyAsSilent?: boolean;
  trigger?: EmbeddedRunTrigger;
}): ReplyExpectation {
  return (
    params.terminalReplyExpectation ??
    ((params.allowEmptyAssistantReplyAsSilent ??
    (params.trigger !== undefined && params.trigger !== "user" && params.trigger !== "manual"))
      ? "optional"
      : "required")
  );
}

/** Reconcile host policy with output/custody facts, never with a model's silence request. */
export function resolveReplyCompletion(
  expectation: ReplyExpectation,
  evidence: ReplyCompletionEvidence,
): ReplyCompletion {
  return expectation === "required"
    ? { expectation, outcome: evidence === "empty" ? "missing" : evidence }
    : { expectation, outcome: evidence === "empty" ? "silent" : evidence };
}

/** Failure to observe a send is not proof that it is safe to generate or send another reply. */
export async function observeReplyDelivery(
  observer: ReplyDeliveryObserver | undefined,
  minimumAssistantMessageIndex: number,
  onError: (error: unknown) => void,
): Promise<ReplyDeliveryState> {
  try {
    return (await observer?.(minimumAssistantMessageIndex)) ?? "missing";
  } catch (error) {
    onError(error);
    return "pending";
  }
}
