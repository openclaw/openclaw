import {
  annotateInterSessionPromptText,
  normalizeInputProvenance,
} from "../sessions/input-provenance.js";
import type { AgentMessage } from "./runtime/index.js";

/** Render persisted source provenance after reconstruction at the final provider boundary. */
export function annotateInterSessionUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = messages.map((message) => {
    if (message.role !== "user") {
      return message;
    }
    const provenance = normalizeInputProvenance(Reflect.get(message, "provenance"));
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
    const content = [...message.content];
    const textIndex = content.findIndex((block) => block.type === "text");
    const existing = content[textIndex];
    if (existing?.type === "text") {
      const text = annotateInterSessionPromptText(existing.text, provenance);
      if (text === existing.text) {
        return message;
      }
      content[textIndex] = { ...existing, text };
    } else {
      content.unshift({
        type: "text",
        text: annotateInterSessionPromptText("Inter-session content follows.", provenance),
      });
    }
    touched = true;
    return { ...message, content };
  });
  return touched ? out : messages;
}
