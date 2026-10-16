import { generateSecureToken } from "../../infra/secure-random.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import type { AgentMessage } from "../runtime/index.js";

export function createDirectCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

export function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}
