import type { SessionContext } from "./runtime/index.js";
/**
 * Session transcript repair integration.
 * Applies repairToolUseResultPairing to session context messages.
 */
import {
  repairToolUseResultPairing,
  type ToolUseRepairReport,
} from "./session-transcript-repair.js";

/** Apply tool-use/tool-result pairing repair to session context. */
export function applySessionTranscriptRepair(context: SessionContext): SessionContext {
  const repairReport: ToolUseRepairReport = repairToolUseResultPairing(context.messages);
  return {
    messages: repairReport.messages,
    thinkingLevel: context.thinkingLevel,
    model: context.model,
  };
}
