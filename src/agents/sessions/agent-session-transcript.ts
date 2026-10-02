import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { Message } from "../../llm/types.js";
import {
  prepareCodeModeSourceAppend,
  type CodeModeSourceAppend,
} from "../transcript-code-mode-source.js";
import { withSessionManagerWrite } from "./session-manager-write-admission.js";
import type { SessionManager } from "./session-manager.js";

/** Persist completed model messages through their existing custody owner. */
export async function persistAgentSessionMessage(
  manager: SessionManager,
  message: Message,
  options: { invalidateSerializedPrefixCache: boolean; sourceAppend?: CodeModeSourceAppend },
): Promise<string | undefined> {
  // Normalize live delivery facts before persistence makes its redacted copy.
  // Stored arguments must never replace the values used for tool execution.
  applyAssistantDeliveryDirectives(message);
  const appendOptions = {
    invalidateSerializedPrefixCache: options.invalidateSerializedPrefixCache,
  };
  prepareCodeModeSourceAppend(appendOptions, message, options.sourceAppend);
  return message.role === "user"
    ? await withSessionManagerWrite(manager, () => manager.appendMessage(message, appendOptions))
    : await manager.appendMessageAsync(message, appendOptions);
}
