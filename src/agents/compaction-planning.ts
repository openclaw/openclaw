import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  getOpenClawSystemUpdateKind,
  isOpenClawRuntimeContextCustomMessage,
  stripRuntimeContextCustomMessages,
} from "./internal-runtime-context.js";
import type { AgentMessage } from "./runtime/index.js";
import { stripToolResultDetails } from "./session-transcript-repair.js";

/**
 * Runtime context never reaches a summary. Nor do prompt updates: compaction starts a new prompt
 * history, and its restart renders every section current.
 */
export function isUnsummarizedCompactionMessage(message: unknown): boolean {
  return (
    isOpenClawRuntimeContextCustomMessage(message) ||
    getOpenClawSystemUpdateKind(message) === "prompt-update"
  );
}

/** Removes unsummarized messages and tool-result details before a summary. */
export function sanitizeCompactionMessages(messages: AgentMessage[]): AgentMessage[] {
  return stripToolResultDetails(
    messages.filter((message) => !isUnsummarizedCompactionMessage(message)),
  );
}

export function estimateMessagesTokens(messages: AgentMessage[]): number {
  return stripToolResultDetails(stripRuntimeContextCustomMessages(messages)).reduce(
    (sum, message) => sum + estimateTokens(message),
    0,
  );
}
