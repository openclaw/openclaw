import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type { TextContent } from "../llm/types.js";
import {
  annotateInterSessionPromptText,
  normalizeInputProvenance,
} from "../sessions/input-provenance.js";
import { isOpenClawAutomationResultMessage } from "../shared/transcript-only-openclaw-assistant.js";
import type { AgentMessage } from "./runtime/index.js";

// Constant text keeps the projection deterministic per row for prompt caching.
const BACKGROUND_RESULT_LABEL =
  "[OpenClaw background result] You sent the message below to the user in this chat from a separate background run. It is a record of what they saw, not a new request.";

/**
 * Render content from another session as labelled user input, identically before assembly,
 * at provider dispatch and in exact-replay facts. Background results are stored as assistant
 * rows for display, but this conversation's model never produced them; replaying them as
 * assistant turns lets the model continue them as its own unprompted pattern.
 */
export function annotateCrossSessionMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = messages.map((message): AgentMessage => {
    if (message?.role === "assistant" && isOpenClawAutomationResultMessage(message)) {
      // Result media lives in display-only fields, and assistant replay already drops managed
      // display blocks, so text is everything this row has ever projected to the model.
      const blocks: TextContent[] =
        typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : message.content.filter((block): block is TextContent => block.type === "text");
      const [first, ...rest] = blocks;
      touched = true;
      return {
        role: "user",
        content: first
          ? [{ ...first, text: `${BACKGROUND_RESULT_LABEL}\n\n${first.text}` }, ...rest]
          : [{ type: "text", text: BACKGROUND_RESULT_LABEL }],
        timestamp: message.timestamp,
      };
    }
    if (message?.role !== "user") {
      return message;
    }
    // SAFETY: Persisted user messages may carry provenance outside AgentMessage; the normalizer validates unknown input.
    const provenance = normalizeInputProvenance((message as { provenance?: unknown }).provenance);
    if (provenance?.kind !== "inter_session") {
      return message;
    }
    if (typeof message.content === "string") {
      const content = annotateInterSessionPromptText(message.content, provenance);
      if (content === message.content) {
        return message;
      }
      touched = true;
      return { ...message, content };
    }
    if (!Array.isArray(message.content)) {
      return message;
    }
    const content = [...message.content];
    const textIndex = content.findIndex((block) => {
      const record = asOptionalObjectRecord(block);
      return record?.type === "text" && typeof record.text === "string";
    });
    if (textIndex < 0) {
      content.unshift({
        type: "text",
        text: annotateInterSessionPromptText("Inter-session content follows.", provenance),
      });
    } else {
      // SAFETY: findIndex above verified this unchanged block's text discriminant and string payload.
      const existing = content[textIndex] as { type: "text"; text: string };
      const text = annotateInterSessionPromptText(existing.text, provenance);
      if (text === existing.text) {
        return message;
      }
      content[textIndex] = { ...existing, text };
    }
    touched = true;
    return { ...message, content };
  });
  return touched ? out : messages;
}
