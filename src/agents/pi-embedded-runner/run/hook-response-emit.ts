/**
 * Helper for the before_response_emit hook.
 *
 * Extracts text content from assistant messages, runs the hook,
 * and returns the modified content (or undefined if no modification).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { HookRunner, PluginHookAgentContext } from "../../../plugins/hooks.js";

const log = createSubsystemLogger("hooks/response-emit");

/** Content part with optional type and text fields (assistant message content array element). */
interface ContentPart {
  type?: string;
  text?: string;
}

export interface ApplyBeforeResponseEmitParams {
  hookRunner: HookRunner;
  agentCtx: PluginHookAgentContext;
  assistantTexts: string[];
  messagesSnapshot: AgentMessage[];
  activeSession: { messages: AgentMessage[] };
  channel?: string;
  /** Number of messages in the session before the current run started.
   *  Used to count actual assistant turns (not assistantTexts.length, which
   *  can have multiple entries per turn with block-reply chunking). */
  preRunMessageCount?: number;
}

/** Result from applyBeforeResponseEmitHook. */
export interface ApplyBeforeResponseEmitResult {
  /** When true, the response was blocked (assistantTexts should be cleared). */
  blocked: boolean;
  /**
   * Modified content for the last assistant message (single-message modification).
   * Undefined when no modification was made or when allContent is provided.
   */
  content?: string;
  /**
   * Modified content for ALL assistant messages in the run (full multi-turn modification).
   * When present, replaces the entire assistantTexts array. Enables PII redaction
   * across all tool-loop iterations, not just the final message.
   */
  allContent?: string[];
}

/**
 * Extract text content from an assistant message.
 * Handles both string content and content-part arrays.
 * Guards against AgentMessage union members that lack `content`.
 */
export function extractAssistantText(msg: AgentMessage): string {
  if (!("content" in msg)) {
    return "";
  }
  const content = (msg as { content: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return (content as ContentPart[])
      .filter((c) => c?.type === "text" || c?.type === "output_text" || c?.type === "input_text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

/**
 * Run the before_response_emit hook and apply modifications.
 *
 * Returns a result describing the hook outcome:
 * - `blocked: true` — response should be suppressed
 * - `content` — modified last-message content (backward-compatible single-message redaction)
 * - `allContent` — modified content for ALL assistant turns (full multi-turn redaction)
 * - `undefined` — no modification was made
 *
 * Plugins receive both `content` (last assistant message) and `allContent`
 * (all assistant texts from the run) in the hook event. They can return
 * either `content` for single-message modification or `allContent` for
 * full-run redaction. `allContent` takes precedence when both are returned.
 */
export async function applyBeforeResponseEmitHook(
  params: ApplyBeforeResponseEmitParams,
): Promise<ApplyBeforeResponseEmitResult | undefined> {
  const { hookRunner, agentCtx, assistantTexts, messagesSnapshot, activeSession, channel } = params;

  // Use assistantTexts (the streamed text accumulator) as the source of truth
  // so content === allContent[allContent.length - 1] always holds.
  // Extracting from the session message can diverge when the final assistant
  // message is tool-call-only (extractAssistantText returns "").
  if (assistantTexts.length === 0) {
    return undefined;
  }
  const content = assistantTexts[assistantTexts.length - 1];

  // Count actual text-bearing assistant turns in the session (not assistantTexts.length,
  // which can have multiple entries per turn with block-reply chunking). When
  // preRunMessageCount is provided, only count messages added during this run.
  // If compaction has shrunk the transcript below preRunMessageCount, the index
  // is stale — fall back to assistantTexts.length to avoid under-scoping.
  const runStart = params.preRunMessageCount ?? 0;
  const compactionShiftedIndices = runStart > activeSession.messages.length;
  let scopeCount: number;
  if (params.preRunMessageCount !== undefined && !compactionShiftedIndices) {
    const runAssistantTurnCount = activeSession.messages
      .slice(runStart)
      .filter((m) => m.role === "assistant" && extractAssistantText(m).length > 0).length;
    // When runAssistantTurnCount is 0 (run ended with tool-call-only turn),
    // fall back to assistantTexts.length instead of clamping to 1. Clamping
    // to 1 would make getRunScopedMessages scan the entire session and
    // potentially return a prior-history message, violating run-scoped isolation.
    // The assistantTexts.length fallback lets the fail-closed guard catch the
    // mismatch if no run-scoped messages are found.
    scopeCount = runAssistantTurnCount > 0 ? runAssistantTurnCount : assistantTexts.length;
  } else {
    // No preRunMessageCount or compaction invalidated it — use assistantTexts.length.
    scopeCount = assistantTexts.length;
  }

  const emitResult = await hookRunner.runBeforeResponseEmit(
    {
      content,
      allContent: [...assistantTexts],
      channel,
      messageCount: messagesSnapshot.length,
    },
    agentCtx,
  );

  // Scope to only current-run messages so we never corrupt prior history.
  // Uses tail-based scan (last N assistant messages) which is compaction-safe.
  const runMessages = getRunScopedMessages(activeSession.messages, scopeCount);

  if (emitResult?.block) {
    log.warn(`response blocked: ${emitResult.blockReason ?? "no reason"}`);
    // For blocking, use broader scope that includes tool-call-only assistant
    // messages (which contain tool call arguments that may hold sensitive data).
    const blockMessages = getRunScopedMessagesForBlock(activeSession.messages, scopeCount);
    if (blockMessages.length === 0 && activeSession.messages.length > 0) {
      // Compaction edge case: couldn't identify run-scoped messages.
      // Fail closed: clear ALL assistant content in the session to prevent
      // blocked/sensitive text from leaking into future turns or persistence.
      log.warn(
        "response blocked but run-scoped messages empty — clearing all assistant content as fail-closed fallback. " +
          "This can occur when compaction makes run boundaries unidentifiable.",
      );
      clearAllAssistantContent(activeSession.messages);
    } else {
      // Remove blocked assistant messages from current-run session history only
      // so they don't leak to subsequent turns or session persistence.
      clearAllAssistantContent(activeSession.messages, blockMessages);
    }
    return { blocked: true };
  }

  // Fail-closed: if run scope resolved to empty (compaction edge case), any
  // rewrite would silently no-op on session history while assistantTexts gets
  // updated — leaving unredacted content in session history for future LLM calls.
  // Block the response to prevent the inconsistency.
  if (
    runMessages.length === 0 &&
    (emitResult?.allContent !== undefined || emitResult?.content !== undefined)
  ) {
    log.warn(
      "response modification requested but run-scoped messages empty — blocking to prevent " +
        "unredacted session history (compaction edge case)",
    );
    clearAllAssistantContent(activeSession.messages);
    return { blocked: true };
  }

  // Check for full multi-turn modification (allContent takes precedence)
  if (emitResult?.allContent !== undefined) {
    // No-op optimization: if the plugin returned allContent unchanged, skip
    // session rewrites to avoid unnecessary work and observer confusion.
    const allContentChanged =
      emitResult.allContent.length !== assistantTexts.length ||
      emitResult.allContent.some((t, i) => t !== assistantTexts[i]);
    if (!allContentChanged) {
      log.debug("allContent unchanged, skipping rewrite");
      return undefined;
    }
    log.debug(
      `applying allContent modification (${emitResult.allContent.length} entries, original ${assistantTexts.length})`,
    );
    rewriteAllAssistantContent(runMessages, emitResult.allContent);
    return { blocked: false, allContent: emitResult.allContent };
  }

  if (emitResult?.content === undefined || emitResult.content === content) {
    log.debug(`no modification (hasResult=${!!emitResult}, hasContent=${!!emitResult?.content})`);
    return undefined;
  }

  log.debug(`applying modified content (len=${emitResult.content.length})`);

  // Update session messages for consistency with the delivery pipeline.
  // We update in-place because activeSession.messages is a mutable array
  // shared with the session persistence layer. Scoped to run messages only.
  rewriteLastAssistantContent(runMessages, emitResult.content);

  return { blocked: false, content: emitResult.content };
}

/**
 * Get the subset of session messages belonging to the current run.
 * Uses tail-based scanning: finds the last N assistant messages (where N
 * is the count produced in this run) and returns everything from the first
 * match onward. This is compaction-safe — works regardless of whether
 * compaction shifted message indices during the run.
 */
export function getRunScopedMessages(
  messages: AgentMessage[],
  assistantTextCount: number,
): AgentMessage[] {
  if (assistantTextCount <= 0) {
    // No assistant texts — return empty slice to avoid touching history.
    return [];
  }
  let assistantsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    // Only count text-bearing assistant messages — tool-call-only messages
    // have content (array with tool_use blocks) but no text. assistantTextCount
    // is derived from streamed text entries, so we must match that filter.
    if (messages[i].role === "assistant" && extractAssistantText(messages[i]).length > 0) {
      assistantsSeen++;
      if (assistantsSeen >= assistantTextCount) {
        return messages.slice(i);
      }
    }
  }
  // Couldn't find enough assistant messages — return empty to avoid
  // corrupting pre-run history. This is a defensive fallback that
  // should rarely occur in practice.
  return [];
}

/**
 * Get ALL messages from the current run for block/scrub operations.
 * Unlike getRunScopedMessages (which only counts text-bearing assistant messages),
 * this includes tool-call-only assistant messages, tool results, and user messages
 * that are part of the run. Uses the same tail-based approach but counts ALL
 * assistant messages (text or tool-call-only) to find the run boundary.
 *
 * This broader scope is needed for blocking because tool-call-only assistant
 * messages contain tool call arguments that may include sensitive data.
 */
export function getRunScopedMessagesForBlock(
  messages: AgentMessage[],
  assistantTextCount: number,
): AgentMessage[] {
  if (assistantTextCount <= 0) {
    return [];
  }
  // Find the first text-bearing assistant message (same boundary as getRunScopedMessages)
  // then extend backward to include any preceding assistant messages that are part
  // of the same run (tool-call-only turns in the same tool loop).
  let assistantsSeen = 0;
  let textBoundaryIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && extractAssistantText(messages[i]).length > 0) {
      assistantsSeen++;
      if (assistantsSeen >= assistantTextCount) {
        textBoundaryIdx = i;
        break;
      }
    }
  }
  if (textBoundaryIdx < 0) {
    return [];
  }
  // Extend backward from textBoundaryIdx to include tool-call-only assistant
  // messages and tool results that precede the first text-bearing message.
  // Stop at:
  // 1. A user message (run boundary), OR
  // 2. A text-bearing assistant message (prior turn), OR
  // 3. The start of the array
  // This prevents overshooting into prior-history in sessions without a user
  // message at the start (sub-agent auto-runs, greeting-first sessions).
  let startIdx = textBoundaryIdx;
  for (let i = textBoundaryIdx - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      break; // Run boundary
    }
    if (msg.role === "assistant" && extractAssistantText(msg).length > 0) {
      break; // Prior turn's text-bearing assistant message
    }
    if (msg.role === "assistant" || msg.role === "toolResult") {
      startIdx = i;
    } else {
      break; // Unknown role, stop
    }
  }
  return messages.slice(startIdx);
}

/**
 * Rewrite text content in the last assistant message.
 * Handles both string content and multi-part content arrays.
 * For multi-part arrays, replaces the first text part with the new content
 * and clears all subsequent text parts to prevent stale/unredacted fragments.
 */
export function rewriteLastAssistantContent(messages: AgentMessage[], newContent: string): void {
  // Must find the last text-bearing assistant message, not just any assistant
  // message with a content field. Tool-use-only messages (e.g. content: [{type: "tool_use", ...}])
  // have "content" but no text parts, so rewriteSingleAssistantMessage would
  // silently no-op — leaving redacted content unpersisted in session history.
  const sessionMsg = messages.findLast(
    (m) => m.role === "assistant" && "content" in m && extractAssistantText(m).length > 0,
  );
  if (!sessionMsg) {
    log.warn(
      "rewriteLastAssistantContent: no text-bearing assistant message found in session history",
    );
    return;
  }
  rewriteSingleAssistantMessage(sessionMsg, newContent);
}

/**
 * Rewrite text content in ALL assistant messages in session history.
 * Maps each entry in `newContents` to the corresponding assistant message
 * (in chronological order). If there are more assistant messages than
 * entries, the extra messages are cleared. If there are fewer, the extra
 * entries are ignored (defensive).
 */
export function rewriteAllAssistantContent(messages: AgentMessage[], newContents: string[]): void {
  // Only count text-bearing assistant messages — matching getRunScopedMessages
  // and assistantTexts counting. Tool-call-only messages are skipped to keep
  // allContent indices aligned.
  const assistantMsgs = messages.filter(
    (m) => m.role === "assistant" && extractAssistantText(m).length > 0,
  );
  if (newContents.length !== assistantMsgs.length) {
    log.warn(
      `rewriteAllAssistantContent: allContent length (${newContents.length}) differs from ` +
        `assistant message count (${assistantMsgs.length}); extras will be cleared`,
    );
  }
  for (let i = 0; i < assistantMsgs.length; i++) {
    if (i < newContents.length) {
      rewriteSingleAssistantMessage(assistantMsgs[i], newContents[i]);
    } else {
      // Extra messages beyond allContent length — remove entirely rather than
      // blanking to "". Empty-content assistant messages break Anthropic API
      // (rejects { role: "assistant", content: "" } or content: []).
      const idx = messages.indexOf(assistantMsgs[i]);
      if (idx >= 0) {
        messages.splice(idx, 1);
      }
    }
  }
}

/**
 * Rewrite text content of a single assistant message in-place.
 */
function rewriteSingleAssistantMessage(msg: AgentMessage, newContent: string): void {
  const msgContent = (msg as { content: unknown }).content;
  if (typeof msgContent === "string") {
    (msg as unknown as Record<string, unknown>).content = newContent;
  } else if (Array.isArray(msgContent)) {
    // Rewrite all text-bearing part types (text, output_text, input_text).
    // Must match the same set as extractAssistantText to avoid silent PII leaks
    // where extraction finds text but rewriting misses the parts.
    const textParts = (msgContent as ContentPart[]).filter(
      (c) => c?.type === "text" || c?.type === "output_text" || c?.type === "input_text",
    );
    if (textParts.length > 0) {
      textParts[0].text = newContent;
      for (let i = 1; i < textParts.length; i++) {
        textParts[i].text = "";
      }
    }
  }
}

/**
 * Remove assistant (and optionally toolResult) messages from the array entirely.
 *
 * When `scope` is provided, only messages present in `scope` are removed
 * (identity comparison via Set). Both `assistant` and `toolResult` messages
 * in scope are removed — leaving orphaned `toolResult` entries after their
 * corresponding `tool_use` assistant message is removed would produce a
 * malformed conversation history that the Anthropic API rejects.
 *
 * When `scope` is omitted, ALL assistant messages with content are removed
 * (toolResult messages are left untouched in the unscoped path since the
 * caller is clearing the entire session and toolResults without a preceding
 * tool_use are already invalid).
 *
 * Messages are removed rather than blanked to avoid ghost entries.
 * Empty-content assistant messages (content: "" or content: []) would persist
 * in session history and cause LLM API failures on the next turn — Anthropic
 * rejects { role: "assistant", content: [] } as invalid.
 */
export function clearAllAssistantContent(messages: AgentMessage[], scope?: AgentMessage[]): void {
  const scopeSet = scope ? new Set(scope) : undefined;
  // Iterate in reverse so splice indices stay valid.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (scopeSet) {
      // Scoped removal: remove both assistant and toolResult messages in scope.
      // toolResult messages must be removed alongside their tool_use assistant
      // messages to avoid orphaned tool results in session history.
      if (!scopeSet.has(msg)) {
        continue;
      }
      if (msg.role !== "assistant" && msg.role !== "toolResult") {
        continue;
      }
    } else {
      // Unscoped: remove all assistant messages with content.
      if (msg.role !== "assistant" || !("content" in msg)) {
        continue;
      }
    }
    messages.splice(i, 1);
  }
}
