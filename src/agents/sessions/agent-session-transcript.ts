import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import { withOwnedSessionRestartAbortWrite } from "../../config/sessions/transcript-write-context.js";
import type { Message } from "../../llm/types.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { AGENT_RUN_RESTART_ABORT_ERROR_CODE } from "../run-termination.js";
import type { SessionManager } from "./session-manager.js";

/** Persist completed model messages through their existing custody owner. */
export async function persistAgentSessionMessage(
  manager: SessionManager,
  message: Message,
  options: { invalidateSerializedPrefixCache: boolean },
): Promise<string | undefined> {
  // Normalize delivery facts before persistence.
  applyAssistantDeliveryDirectives(message);
  const appendOptions = {
    invalidateSerializedPrefixCache: options.invalidateSerializedPrefixCache,
  };
  const append = () => manager.appendMessageAsync(message, appendOptions);
  const entryId =
    message.role === "assistant" &&
    (message.stopReason === "aborted" || message.stopReason === "error") &&
    message.errorCode === AGENT_RUN_RESTART_ABORT_ERROR_CODE
      ? await withOwnedSessionRestartAbortWrite(manager.getSessionTarget(), append)
      : await append();
  if (message.role === "assistant" && !isOwnedTranscriptPayload(message)) {
    // Storage sanitization can seal a copy. The completed live reply owns its original bytes.
    freezeJsonSnapshot(message);
  }
  return entryId;
}
