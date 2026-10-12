import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { Message } from "../../llm/types.js";
import {
  prepareCodeModeSourceAppend,
  type CodeModeSourceAppend,
} from "../transcript-code-mode-source.js";
import { sanitizeOpenAIReasoningSignature } from "../transcript-redact.js";
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
  // Encrypted reasoning must replay the stored signature on the next live continuation.
  if (message.role === "assistant") {
    message.content = message.content.map((block) => {
      if (block.type !== "thinking" || !block.thinkingSignature) {
        return block;
      }
      const reasoning = safeParseJsonRecord(block.thinkingSignature);
      // Plaintext-only reasoning still needs its content during the current turn.
      if (
        typeof reasoning?.encrypted_content !== "string" ||
        reasoning.encrypted_content.length === 0
      ) {
        return block;
      }
      const thinkingSignature =
        sanitizeOpenAIReasoningSignature(block.thinkingSignature, message) ??
        block.thinkingSignature;
      return thinkingSignature === block.thinkingSignature
        ? block
        : { ...block, thinkingSignature };
    });
  }
  const appendOptions = {
    invalidateSerializedPrefixCache: options.invalidateSerializedPrefixCache,
  };
  prepareCodeModeSourceAppend(appendOptions, message, options.sourceAppend);
  return await manager.appendMessageAsync(message, appendOptions);
}
