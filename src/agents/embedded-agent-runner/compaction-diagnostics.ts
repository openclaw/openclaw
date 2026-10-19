import { isRealConversationMessage } from "../compaction-real-conversation.js";
import type { AgentMessage } from "../runtime/index.js";

export function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
}
