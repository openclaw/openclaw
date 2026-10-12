import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { Message } from "../../llm/types.js";
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
  return await manager.appendMessageAsync(message, appendOptions);
}
