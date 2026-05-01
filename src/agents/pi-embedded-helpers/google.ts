import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isGemma4ModelId } from "../../shared/google-models.js";
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export const GOOGLE_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

export function isGemma4ModelRequiringReasoningStrip(modelId?: string | null): boolean {
  return isGemma4ModelId(modelId);
}

export { sanitizeGoogleTurnOrdering };

export function ensureGoogleToolCallThoughtSignatures(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  let touched = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object" || (msg as { role?: unknown }).role !== "assistant") {
      return msg;
    }
    const assistant = msg as Extract<AgentMessage, { role: "assistant" }>;
    if (!Array.isArray(assistant.content)) {
      return msg;
    }
    let contentChanged = false;
    const nextContent = assistant.content.map((block) => {
      if (!block || typeof block !== "object") {
        return block;
      }
      const record = block as { type?: unknown; thoughtSignature?: unknown };
      if (record.type !== "toolCall") {
        return block;
      }
      const signature =
        typeof record.thoughtSignature === "string" ? record.thoughtSignature.trim() : "";
      if (signature) {
        return block;
      }
      contentChanged = true;
      return {
        ...(record as Record<string, unknown>),
        thoughtSignature: GOOGLE_THOUGHT_SIGNATURE_SENTINEL,
      };
    });
    if (!contentChanged) {
      return msg;
    }
    touched = true;
    return { ...assistant, content: nextContent };
  });
  return touched ? out : messages;
}
