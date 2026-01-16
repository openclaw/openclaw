/**
 * Transcript repair/sanitization extension.
 *
 * Runs on every context build to prevent strict provider request rejections:
 * - duplicate or displaced tool results (Anthropic-compatible APIs, MiniMax, Cloud Code Assist)
 * - Cloud Code Assist tool call ID constraints + collision-safe sanitization
 * - Tool-call markup leakage into context (context poisoning prevention)
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { isGoogleModelApi } from "../pi-embedded-helpers.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "../tool-call-id.js";
import { stripDowngradedToolCallText } from "../pi-embedded-utils.js";

/**
 * Strip tool-call markup from assistant text blocks.
 * This prevents context poisoning where downgraded tool calls like
 * [Tool Call: ...] and [Tool Result for ID ...] appear in
 * context windows and are imitated by other models.
 */
function sanitizeAssistantTextBlocks(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    if ((msg as { role?: unknown }).role !== "assistant") return msg;

    const assistantMsg = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistantMsg.content)) return msg;

    const newContent = assistantMsg.content.map((block) => {
      if (!block || typeof block !== "object") return block;
      if ((block as { type?: unknown }).type !== "text") return block;

      const textBlock = block as { text: string };
      return {
        type: "text",
        text: stripDowngradedToolCallText(textBlock.text),
      };
    });

    // Remove empty text blocks after sanitization
    const filteredContent = newContent.filter((block) => {
      // Keep all non-text blocks (tool_use, tool_result, images, etc.)
      if ((block as { type?: unknown }).type !== "text") return true;  
      // Only filter text blocks
      const textBlock = block as { text: string };
      return textBlock.text !== "" && textBlock.text !== undefined;
    });

    return {
      ...assistantMsg,
      content: filteredContent.length > 0 ? filteredContent : assistantMsg.content,
    };
  });
}

export default function transcriptSanitizeExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, ctx: ExtensionContext) => {
    let next = event.messages as AgentMessage[];

    // 1. Repair tool use/result pairing
    const repaired = repairToolUseResultPairing(next);
    if (repaired.messages !== next) next = repaired.messages;

    // 2. Sanitize tool call IDs for Cloud Code Assist
    if (isGoogleModelApi(ctx.model?.api)) {
      const repairedIds = sanitizeToolCallIdsForCloudCodeAssist(next);
      if (repairedIds !== next) next = repairedIds;
    }

    // 3. Strip tool-call markup from assistant text to prevent context poisoning
    const sanitized = sanitizeAssistantTextBlocks(next);
    if (sanitized !== next) next = sanitized;

    if (next === event.messages) return undefined;
    return { messages: next };
  });
}
