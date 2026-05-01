import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { isGemma4ModelId } from "../../shared/google-models.js";
import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export const GOOGLE_THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;
type AssistantContentBlock = AssistantAgentMessage["content"][number];
type GoogleToolCallBlock = AssistantContentBlock & {
  type: "toolCall";
  thoughtSignature?: unknown;
};

export function isGoogleModelApi(api?: string | null): boolean {
  return api === "google-gemini-cli" || api === "google-generative-ai";
}

export function isGemma4ModelRequiringReasoningStrip(modelId?: string | null): boolean {
  return isGemma4ModelId(modelId);
}

export { sanitizeGoogleTurnOrdering };

function isGoogleToolCallBlock(block: AssistantContentBlock): block is GoogleToolCallBlock {
  return typeof block === "object" && block !== null && block.type === "toolCall";
}

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
    const nextContent: AssistantAgentMessage["content"] = assistant.content.map((block) => {
      if (!isGoogleToolCallBlock(block)) {
        return block;
      }
      const signature =
        typeof block.thoughtSignature === "string" ? block.thoughtSignature.trim() : "";
      if (signature) {
        return block;
      }
      contentChanged = true;
      return {
        ...block,
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
