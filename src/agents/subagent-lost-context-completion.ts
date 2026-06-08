/**
 * Reconcile stale active subagent runs that lost live execution context.
 *
 * When the sweeper cannot resolve terminal state from the session store, visible child
 * assistant output is treated as ground truth — the subagent completed successfully while the
 * parent still needs the result.  Without this reconciliation, the parent receives a plain
 * failure despite the child having delivered output, causing a lifecycle/result mismatch.
 *
 * Only visible (non-silent, non-skip) assistant text qualifies for recovery.  Tool-call-only
 * histories and silent reply tokens keep the existing lost-context error path so the parent
 * gets an honest signal.
 */
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { callGateway } from "../gateway/call.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

export const LOST_ACTIVE_EXECUTION_CONTEXT_ERROR = "subagent run lost active execution context";

function extractAssistantVisibleText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const m = message as Record<string, unknown>;
  if (m.role !== "assistant") return "";
  const content = m.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("")
      .trim();
  }
  return "";
}

function hasVisibleAssistantOutput(messages: unknown[]): boolean {
  for (const msg of messages) {
    const text = extractAssistantVisibleText(msg);
    if (!text) continue;
    if (isAnnounceSkip(text)) continue;
    if (isSilentReplyText(text, SILENT_REPLY_TOKEN)) continue;
    return true;
  }
  return false;
}

/** Resolve terminal outcome for a stale active run with no live `agent.run` context. */
export async function resolveStaleActiveSubagentOutcome(params: {
  childSessionKey: string;
}): Promise<SubagentRunOutcome> {
  const history = await callGateway({
    method: "chat.history",
    params: { sessionKey: params.childSessionKey, limit: 100 },
  });
  const messages: unknown[] = Array.isArray(history?.messages) ? history.messages : [];
  if (hasVisibleAssistantOutput(messages)) {
    return { status: "ok" };
  }
  return {
    status: "error",
    error: LOST_ACTIVE_EXECUTION_CONTEXT_ERROR,
  };
}
