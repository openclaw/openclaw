import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { stripRuntimeContextCustomMessages } from "./internal-runtime-context.js";
import type { AgentMessage } from "./runtime/index.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";

/** Buffer for estimateTokens() inaccuracy. */
export const SAFETY_MARGIN = 1.2;

/** Removes runtime-only context and tool-result details before token estimates or summaries. */
export function sanitizeCompactionMessages(messages: AgentMessage[]): AgentMessage[] {
  return stripToolResultDetails(stripRuntimeContextCustomMessages(messages));
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return sanitizeCompactionMessages(messages).reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
}
