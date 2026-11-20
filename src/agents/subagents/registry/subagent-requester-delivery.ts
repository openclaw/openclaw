import {
  trackSessionControllerSourceWork,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import type { SubagentCompletionDeliveryState } from "./subagent-registry-read.types.js";

/** Source custody owns write failures; this join preserves the transport outcome. */
export function observeSubagentRequesterDelivery(
  input: SessionControllerInput,
  record: (
    fact: NonNullable<SubagentCompletionDeliveryState["requesterDelivery"]>,
  ) => Promise<void>,
): () => Promise<void> | undefined {
  let consumption: Promise<void> | undefined;
  input.onTranscriptCommitted = (runId) => {
    consumption ??= record({ state: "consumed", runId, at: Date.now() });
    trackSessionControllerSourceWork(input, consumption);
    return consumption;
  };
  return () => consumption?.catch(() => undefined);
}
