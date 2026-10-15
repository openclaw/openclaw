import { generateSecureToken } from "../../infra/secure-random.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import type { AgentMessage } from "../runtime/index.js";
import { estimateTokens } from "../sessions/index.js";

export function createDirectCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

function getMessageTextChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  return Array.isArray(content)
    ? content.reduce((total, block) => {
        const text =
          block && typeof block === "object" ? (block as { text?: unknown }).text : undefined;
        return total + (typeof text === "string" ? text.length : 0);
      }, 0)
    : 0;
}

function resolveMessageToolLabel(msg: AgentMessage): string | undefined {
  const candidate =
    (msg as { toolName?: unknown }).toolName ??
    (msg as { name?: unknown }).name ??
    (msg as { tool?: unknown }).tool;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

export function summarizeCompactionMessages(messages: AgentMessage[]) {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: Array<{ role: string; chars: number; tool?: string }> = [];
  let estTokens: number | undefined = 0;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const chars = getMessageTextChars(msg);
    historyTextChars += chars;
    if (role === "toolResult") {
      toolResultChars += chars;
    }
    contributors.push({ role, chars, tool: resolveMessageToolLabel(msg) });
    if (estTokens !== undefined) {
      try {
        estTokens += estimateTokens(msg);
      } catch {
        estTokens = undefined;
      }
    }
  }

  return {
    messages: messages.length,
    historyTextChars,
    toolResultChars,
    estTokens,
    contributors: contributors.toSorted((left, right) => right.chars - left.chars).slice(0, 3),
  };
}

export function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}
