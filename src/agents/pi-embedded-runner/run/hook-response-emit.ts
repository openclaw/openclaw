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
      .filter((c) => c?.type === "text")
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

  // Find last assistant message
  const lastAssistantMsg = [...messagesSnapshot].toReversed().find((m) => m.role === "assistant");
  if (!lastAssistantMsg || !("content" in lastAssistantMsg)) {
    // No assistant message at all — only skip if there's also no allContent.
    // This guards against runs where the only output is in earlier turns.
    if (assistantTexts.length === 0) {
      return undefined;
    }
  }

  const content = lastAssistantMsg ? extractAssistantText(lastAssistantMsg) : "";
  // Don't skip when content is empty but allContent has entries — policy
  // plugins need the chance to inspect/block earlier assistant turns even
  // when the final message is tool-call-only or non-text.
  if (!content && assistantTexts.length === 0) {
    return undefined;
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
  const runMessages = getRunScopedMessages(activeSession.messages, assistantTexts.length);

  if (emitResult?.block) {
    log.warn(`response blocked: ${emitResult.blockReason ?? "no reason"}`);
    if (runMessages.length === 0) {
      // Compaction edge case: couldn't identify run-scoped messages.
      // Response delivery is still suppressed, but blocked content may
      // persist in activeSession.messages and leak into future turns.
      log.warn(
        "response blocked but run-scoped messages empty — blocked content may persist in session history. " +
          "This can occur when compaction makes run boundaries unidentifiable.",
      );
    }
    // Clear blocked content from current-run session history only so it
    // doesn't leak to subsequent turns or session persistence. Prior turns
    // that were already delivered are left intact.
    clearAllAssistantContent(runMessages);
    return { blocked: true };
  }

  // Check for full multi-turn modification (allContent takes precedence)
  if (emitResult?.allContent !== undefined) {
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
 * Rewrite text content in the last assistant message.
 * Handles both string content and multi-part content arrays.
 * For multi-part arrays, replaces the first text part with the new content
 * and clears all subsequent text parts to prevent stale/unredacted fragments.
 */
export function rewriteLastAssistantContent(messages: AgentMessage[], newContent: string): void {
  const sessionMsg = [...messages]
    .toReversed()
    .find((m) => m.role === "assistant" && "content" in m);
  if (!sessionMsg) {
    log.warn("rewriteLastAssistantContent: no assistant message found in session history");
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
    const replacement = i < newContents.length ? newContents[i] : "";
    rewriteSingleAssistantMessage(assistantMsgs[i], replacement);
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
    const textParts = (msgContent as ContentPart[]).filter((c) => c?.type === "text");
    if (textParts.length > 0) {
      textParts[0].text = newContent;
      for (let i = 1; i < textParts.length; i++) {
        textParts[i].text = "";
      }
    }
  }
}

/**
 * Clear all text content from ALL assistant messages in session history.
 * Used when before_response_emit blocks delivery to prevent data leaks.
 */
function clearAllAssistantContent(messages: AgentMessage[]): void {
  const assistantMsgs = messages.filter((m) => m.role === "assistant" && "content" in m);
  for (const msg of assistantMsgs) {
    rewriteSingleAssistantMessage(msg, "");
  }
}
