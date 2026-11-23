import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import {
  hasConsumedPrivateRequesterInput,
  resolveRequesterDeliveryOutcome,
} from "../registry/subagent-delivery-state.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { recordRequiredCompletionNotice } from "./subagent-completion-admission.store.js";

/** Transcript custody prevents replay, but cannot substitute for a visible outcome. */
export async function settleConsumedRequesterDelivery(
  entries: readonly SubagentRunRecord[],
  outcome: SubagentAnnounceDeliveryResult,
): Promise<SubagentAnnounceDeliveryResult> {
  const settled = resolveRequesterDeliveryOutcome(entries, outcome)!;
  const required = entries.filter(
    (entry) => entry.expectsCompletionMessage === true && !hasConsumedPrivateRequesterInput(entry),
  );
  if (settled !== outcome && required[0]) {
    await recordRequiredCompletionNotice(
      required[0],
      outcome.error ?? outcome.reason ?? "Requester did not produce a visible reply",
      required,
      "result",
    );
  }
  return settled;
}
