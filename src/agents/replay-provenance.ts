import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  annotateInterSessionPromptText,
  normalizeInputProvenance,
} from "../sessions/input-provenance.js";
import type { AgentMessage } from "./runtime/index.js";

/** Render persisted source provenance identically before assembly and at provider dispatch. */
export function annotateInterSessionUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = messages.map((message) => {
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
