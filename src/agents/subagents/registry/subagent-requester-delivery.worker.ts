import { listSessionPendingInputReceipts } from "../../../config/sessions/session-accessor.sqlite-pending-input-receipts.js";
import { readTranscriptEventAtSeqInTransaction } from "../../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import {
  readIdempotencyKeyOwner,
  readTranscriptMessageByEventId,
} from "../../../config/sessions/session-accessor.sqlite-transcript-identity.js";
import {
  readRequesterDeliveryReceipt,
  requesterDeliveryReceiptKey,
} from "../../../sessions/requester-delivery-receipt.js";
import { readSessionTranscriptRunId } from "../../../sessions/transcript-events.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import { recordRequesterDelivery, requesterDeliveryInputKey } from "./subagent-delivery-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Worker-only projection. Missing/unreadable requester receipts preserve the raw registry fact. */
export function projectSubagentRequesterDelivery(entry: SubagentRunRecord): SubagentRunRecord {
  if (
    entry.delivery?.requesterDelivery?.state === "consumed" ||
    !["pending", "in_progress"].includes(entry.delivery?.status ?? "") ||
    !entry.completionRequesterSessionId ||
    !entry.requesterAgentId
  ) {
    return entry;
  }
  const inputIdempotencyKey = requesterDeliveryInputKey(entry);
  try {
    const scope = {
      agentId: entry.requesterAgentId,
      sessionKey: entry.requesterSessionKey,
      sessionId: entry.completionRequesterSessionId,
      storePath: entry.requesterStorePath,
    };
    const resolved = resolveSqliteTranscriptScope(scope);
    const result = withOpenClawAgentDatabaseReadOnly((database) => {
      for (const key of [requesterDeliveryReceiptKey(inputIdempotencyKey), inputIdempotencyKey]) {
        const owner = readIdempotencyKeyOwner(database, scope.sessionId, key);
        const receipt =
          owner &&
          readRequesterDeliveryReceipt(
            readTranscriptEventAtSeqInTransaction(database, scope.sessionId, owner.seq)?.event,
          );
        if (receipt?.inputIdempotencyKey === inputIdempotencyKey) {
          return receipt.runId;
        }
      }
      const receipt = listSessionPendingInputReceipts(scope, {
        runIds: [inputIdempotencyKey.slice(0, -5)],
      })[0];
      if (receipt?.state === "consumed") {
        return readSessionTranscriptRunId(
          readTranscriptMessageByEventId(database, resolved, receipt.consumedByEventId)?.message,
        );
      }
      return undefined;
    }, toDatabaseOptions(resolved));
    if (result.found && result.value) {
      recordRequesterDelivery(entry, {
        state: "consumed",
        runId: result.value,
      });
    }
  } catch {
    // Receipt availability cannot turn waiting into consumption or close its delivery obligation.
  }
  return entry;
}
