import { extractCompactionMessageText } from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { projectRecordedModelPrompt } from "../../sessions/user-turn-transcript.message.js";
import type { AgentMessage } from "../runtime/index.js";

export function hasProjectedSummaryText(messages: AgentMessage[]): boolean {
  // Canonical excerpts cannot preserve document text captured only in a
  // model projection, even when all turns fit the preserved-excerpt count.
  return messages.some(
    (message) =>
      extractCompactionMessageText(projectRecordedModelPrompt(message)) !==
      extractCompactionMessageText(message),
  );
}
