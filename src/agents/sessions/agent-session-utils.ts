import { collectTextContentBlocks } from "../content-blocks.js";
import type { AgentMessage } from "../runtime/index.js";
import { estimateTokens } from "../runtime/index.js";

export function unwrapCoreResult<T>(
  result: { ok: true; value: T } | { ok: false; error: Error },
): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

export function hasPersistedAssistantContent(content: unknown): boolean {
  return (typeof content === "string" || Array.isArray(content)) && content.length > 0;
}

export function extractTextContent(content: unknown): string {
  return typeof content === "string" ? content : collectTextContentBlocks(content).join("");
}

export function replaceAgentMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
  // Agent-core stores the finalized message object before emitting message_end.
  // Mutating it in place keeps agent state, later events, and persistence in sync.
  if (target === replacement) {
    return;
  }
  for (const key of Object.keys(target)) {
    Reflect.deleteProperty(target, key);
  }
  Object.assign(target, replacement);
}

export function estimateMessagesFromContent(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message), 0);
}
