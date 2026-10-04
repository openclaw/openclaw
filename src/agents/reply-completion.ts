import type { InputProvenance } from "../sessions/input-provenance.js";
import type { EmbeddedRunTrigger } from "./run-trigger.js";

export type ReplyExpectation = "required" | "optional";
export type ReplyDeliveryState = "delivered" | "pending" | "missing";
export type ReplyDeliveryObserver = (
  minimumAssistantMessageIndex?: number,
) => Promise<ReplyDeliveryState>;
type ReplyCompletionEvidence = "ready" | "delivered" | "pending" | "blocked" | "silent" | "empty";

/** The input owner selects expectation; terminal evidence preserves intentional silence. */
export type ReplyCompletion =
  | {
      readonly expectation: "required";
      readonly outcome: Exclude<ReplyCompletionEvidence, "empty"> | "missing";
    }
  | {
      readonly expectation: "optional";
      readonly outcome: Exclude<ReplyCompletionEvidence, "empty"> | "silent";
    };

/** Returns true when a lifecycle turn must not redefine session-stable reply policy. */
export function isSyntheticSourceReplyTurn(params: {
  inputProvenance?: InputProvenance;
  isHeartbeat?: boolean;
}): boolean {
  return (
    params.isHeartbeat === true ||
    params.inputProvenance?.kind === "inter_session" ||
    params.inputProvenance?.kind === "internal_system"
  );
}
/** Resolve legacy runtime inputs once; explicit host requiredness always wins. */
export function resolveReplyExpectation(params: {
  terminalReplyExpectation?: ReplyExpectation;
  allowEmptyAssistantReplyAsSilent?: boolean;
  trigger?: EmbeddedRunTrigger;
  inputProvenance?: InputProvenance;
}): ReplyExpectation {
  return (
    params.terminalReplyExpectation ??
    (isSyntheticSourceReplyTurn(params) ||
    (params.allowEmptyAssistantReplyAsSilent ??
      (params.trigger !== undefined && params.trigger !== "user" && params.trigger !== "manual"))
      ? "optional"
      : "required")
  );
}

/** Reconcile reply policy with terminal output and delivery evidence. */
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
