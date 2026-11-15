import { sameSessionTranscriptStorePath } from "../../../config/sessions/transcript-store-identity.js";
import type { RequesterDeliveryReceipt } from "../../../sessions/requester-delivery-receipt.js";
import type { InternalSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import { recordRequesterDelivery, requesterDeliveryInputKey } from "./subagent-delivery-state.js";
import {
  getSubagentRunsForRequesterSession,
  immutableSubagentRun,
} from "./subagent-registry-memory.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "./subagent-run-generation.js";

/** Consume the transcript owner's committed publication without another durable write. */
export function publishRequesterDeliveryReceipt(
  runs: Map<string, SubagentRunRecord>,
  target: NonNullable<InternalSessionTranscriptUpdate["target"]>,
  receipt: RequesterDeliveryReceipt,
): void {
  const changed: string[] = [];
  // Publishing replaces members in the requester index we are walking.
  const entries = [...getSubagentRunsForRequesterSession(target.sessionKey)];
  for (const entry of entries) {
    if (
      entry.delivery?.requesterDelivery?.state === "consumed" ||
      entry.requesterAgentId !== target.agentId ||
      entry.completionRequesterSessionId !== target.sessionId ||
      (entry.requesterStorePath !== undefined &&
        !sameSessionTranscriptStorePath(entry.requesterStorePath, target.storePath)) ||
      requesterDeliveryInputKey(entry) !== receipt.inputIdempotencyKey
    ) {
      continue;
    }
    const next = copySubagentRunRuntimeOwner(entry, {
      ...entry,
      delivery: entry.delivery && { ...entry.delivery },
    });
    recordRequesterDelivery(next, {
      state: "consumed",
      runId: receipt.runId,
      at: Date.now(),
    });
    runs.set(next.runId, immutableSubagentRun(next));
    changed.push(next.runId);
  }
  if (changed.length) {
    publishSubagentRunChanges([target.sessionKey], changed);
  }
}
