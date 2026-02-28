import type { ContextEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { repairToolUseResultPairing } from "../session-transcript-repair.js";

const log = createSubsystemLogger("transcript-sanitize");

/**
 * Extension that repairs orphaned tool_result blocks in the context messages
 * right before each API call.
 *
 * Compaction can split tool_use/tool_result pairs when the assistant message
 * containing tool_use is summarized away while the corresponding tool_result
 * remains. This causes Anthropic's API to reject the request with:
 *   "unexpected tool_use_id found in tool_result blocks"
 *
 * The existing sanitizeSessionHistory() in attempt.ts only runs once at session
 * start; orphans created by mid-conversation compaction are not caught.
 * This extension hooks into the "context" event (fired before every API call)
 * to ensure orphaned tool_results are always dropped.
 *
 * See: https://github.com/openclaw/openclaw/issues/30044
 */
export default function transcriptSanitizeExtension(api: ExtensionAPI): void {
  api.on("context", (event: ContextEvent, _ctx: ExtensionContext) => {
    let report;
    try {
      report = repairToolUseResultPairing(event.messages);
    } catch (err) {
      log.warn(`transcript sanitize failed, passing through: ${String(err)}`);
      return undefined;
    }

    const changed =
      report.added.length > 0 ||
      report.droppedOrphanCount > 0 ||
      report.droppedDuplicateCount > 0 ||
      report.moved;

    if (!changed) {
      return undefined;
    }

    log.info(
      `Repaired tool_use/tool_result pairing before API call: ` +
        `dropped ${report.droppedOrphanCount} orphan(s), ` +
        `${report.droppedDuplicateCount} duplicate(s), ` +
        `added ${report.added.length} synthetic result(s)` +
        (report.moved ? ", reordered displaced results" : ""),
    );

    return { messages: report.messages };
  });
}
