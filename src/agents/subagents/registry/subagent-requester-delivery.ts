import {
  trackSessionControllerSourceWork,
  type SessionControllerInput,
} from "../../../sessions/session-controller.mailbox.js";
import type { SubagentCompletionDeliveryState } from "./subagent-registry-read.types.js";

/** Observe the mailbox and transcript owners without settling their execution. */
export async function observeSubagentRequesterDelivery(
  input: SessionControllerInput,
  runId: string,
  record: (
    fact: NonNullable<SubagentCompletionDeliveryState["requesterDelivery"]>,
  ) => Promise<void>,
): Promise<() => Promise<void>> {
  let consumption: Promise<void> | undefined;
  input.onTranscriptCommitted = (consumingRunId) => {
    consumption ??= record({ state: "consumed", runId: consumingRunId, at: Date.now() });
    trackSessionControllerSourceWork(input, consumption);
    return consumption;
  };
  const claim = input.mailbox.claim;
  await record({
    state: "waiting",
    runId,
    at: Date.now(),
    blockingRunId: claim?.inputs.find((source) => source !== input)?.protocolRunId,
  });
  return async () => {
    await consumption;
  };
}
