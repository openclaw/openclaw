/**
 * Helper for the before_response_emit hook.
 *
 * Extracts text content from the last assistant message, runs the hook,
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
 * Returns the modified content string if the hook changed it,
 * or undefined if no modification was made (or hook blocked/failed).
 */
export async function applyBeforeResponseEmitHook(
  params: ApplyBeforeResponseEmitParams,
): Promise<string | undefined> {
  const { hookRunner, agentCtx, messagesSnapshot, activeSession, channel } = params;

  // Find last assistant message
  const lastAssistantMsg = [...messagesSnapshot].toReversed().find((m) => m.role === "assistant");
  if (!lastAssistantMsg || !("content" in lastAssistantMsg)) {
    return undefined;
  }

  const content = extractAssistantText(lastAssistantMsg);
  if (!content) {
    return undefined;
  }

  const emitResult = await hookRunner.runBeforeResponseEmit(
    {
      content,
      channel,
      messageCount: messagesSnapshot.length,
    },
    agentCtx,
  );

  if (emitResult?.block) {
    log.warn(`response blocked: ${emitResult.blockReason ?? "no reason"}`);
    // Clear blocked content from session history so it doesn't leak to
    // subsequent turns or session persistence.
    clearAssistantContent(activeSession.messages);
    // Return empty string to signal the caller that the response was blocked.
    // The caller checks `modifiedContent !== undefined` — returning undefined
    // would be indistinguishable from "no modification".
    return "";
  }

  if (emitResult?.content === undefined || emitResult.content === content) {
    log.debug(`no modification (hasResult=${!!emitResult}, hasContent=${!!emitResult?.content})`);
    return undefined;
  }

  log.debug(`applying modified content (len=${emitResult.content.length})`);

  // Update session messages for consistency with the delivery pipeline.
  // We update in-place because activeSession.messages is a mutable array
  // shared with the session persistence layer.
  rewriteAssistantContent(activeSession.messages, emitResult.content);

  return emitResult.content;
}

/**
 * Rewrite all text content in the last assistant message.
 * Handles both string content and multi-part content arrays.
 * For multi-part arrays, replaces the first text part with the new content
 * and clears all subsequent text parts to prevent stale/unredacted fragments.
 */
function rewriteAssistantContent(messages: AgentMessage[], newContent: string): void {
  // Scan backwards for the last assistant message — same strategy as
  // applyBeforeResponseEmitHook. Don't assume messages[-1] is assistant;
  // tool results or other entries may have been appended since the snapshot.
  const sessionMsg = [...messages]
    .toReversed()
    .find((m) => m.role === "assistant" && "content" in m);
  if (!sessionMsg) {
    log.warn("rewriteAssistantContent: no assistant message found in session history");
    return;
  }
  const msgContent = (sessionMsg as { content: unknown }).content;
  if (typeof msgContent === "string") {
    (sessionMsg as unknown as Record<string, unknown>).content = newContent;
  } else if (Array.isArray(msgContent)) {
    const textParts = (msgContent as ContentPart[]).filter((c) => c?.type === "text");
    if (textParts.length > 0) {
      textParts[0].text = newContent;
      // Clear all subsequent text parts to prevent stale/unredacted fragments
      for (let i = 1; i < textParts.length; i++) {
        textParts[i].text = "";
      }
    }
  }
}

/**
 * Clear all text content from the last assistant message in session history.
 * Used when before_response_emit blocks delivery to prevent data leaks.
 */
function clearAssistantContent(messages: AgentMessage[]): void {
  rewriteAssistantContent(messages, "");
}
