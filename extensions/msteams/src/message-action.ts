// Msteams plugin module: Teams message actions ("Ask OpenClaw about this").
//
// A Teams *message action* (a command in the message "..." overflow menu) arrives as a
// `composeExtension/submitAction` invoke whose `value.messagePayload` carries the selected
// message. We turn that into a normal agent turn: extract + sanitize the message text, build a
// prompt, and dispatch it through the same path as a typed message so the reply lands in the
// conversation. This file holds the pure, testable extraction/prompt logic; the wiring lives in
// monitor.ts (the `message.ext.submit` invoke route) and monitor-handler.ts (the dispatch branch).
import { stripHtmlFromTeamsMessage } from "./graph-thread.js";

/** The manifest commandId for the "Ask OpenClaw about this" message action. */
export const MSTEAMS_ASK_OPENCLAW_COMMAND = "askOpenClaw";

/** Shape of the `composeExtension/submitAction` invoke value for a message-context command. */
export interface MSTeamsMessageActionValue {
  commandId?: string;
  commandContext?: string;
  botMessagePreviewAction?: string;
  messagePayload?: {
    body?: { content?: string; contentType?: string };
    from?: { user?: { displayName?: string } };
  };
}

/** Cap the quoted message so a huge selected message can't blow up the prompt. */
const MAX_QUOTED_CHARS = 4000;

/**
 * Extract the human-readable text of the message the user invoked the action on. Strips HTML
 * (preserving @mentions), collapses whitespace, and caps length. Returns undefined when there is
 * no usable text (e.g. a card-only or empty message).
 */
export function extractMessageActionText(
  value: MSTeamsMessageActionValue | undefined,
): string | undefined {
  const raw = value?.messagePayload?.body?.content;
  if (!raw || typeof raw !== "string") {
    return undefined;
  }
  const text = stripHtmlFromTeamsMessage(raw).slice(0, MAX_QUOTED_CHARS).trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Build the agent prompt for a message action. The selected message is quoted as context and the
 * agent is asked to help with it — the user picked the action without typing, so the instruction is
 * implicit ("explain / summarize / act on this message").
 */
export function buildMessageActionPrompt(
  value: MSTeamsMessageActionValue | undefined,
): string | undefined {
  const text = extractMessageActionText(value);
  if (!text) {
    return undefined;
  }
  const author = value?.messagePayload?.from?.user?.displayName?.trim();
  const attribution = author ? ` (from ${author})` : "";
  return (
    `I used the "Ask OpenClaw about this" action on the following Teams message${attribution}. ` +
    `Help me with it — explain, summarize, or act on it as appropriate, and ask me to clarify if my ` +
    `intent is ambiguous.\n\n--- message ---\n${text}\n--- end ---`
  );
}

/** True when this invoke value is the Ask-OpenClaw message action (or any message-context command). */
export function isMessageActionInvoke(value: MSTeamsMessageActionValue | undefined): boolean {
  if (!value) {
    return false;
  }
  // Accept our command id, or any command whose context is a selected message — the prompt builder
  // gates on actually having message text, so a non-message command simply produces no prompt.
  return value.commandId === MSTEAMS_ASK_OPENCLAW_COMMAND || value.commandContext === "message";
}
