import type { MemoryRef } from "../ref.js";
import { contentHash, normalizeForMatch } from "./normalize.js";

// Conversation-derived candidates do not correspond to any real file. Use a
// reserved path prefix so they can never collide with a builtin chunks row or
// a qmd-served file path.
export const CONVERSATION_PATH_PREFIX = ":conversation/";

export function synthesizeConversationRef(params: {
  sessionId: string;
  messageIndex: number;
  candidateText: string;
}): MemoryRef {
  const normalized = normalizeForMatch(params.candidateText);
  return {
    source: "memory",
    path: `${CONVERSATION_PATH_PREFIX}${params.sessionId}`,
    startLine: params.messageIndex,
    endLine: params.messageIndex,
    contentHash: contentHash(normalized),
  };
}
