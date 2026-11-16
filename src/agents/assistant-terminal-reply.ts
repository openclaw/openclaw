import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { resolveRawAssistantAnswerText } from "../shared/assistant-answer-text.js";
import {
  prepareAgentRunTerminalReply,
  sanitizeAgentRunTerminalReply,
} from "./agent-run-terminal-reply.js";
import {
  extractAssistantVisibleText,
  prepareAssistantVisibleText,
  type AssistantTextSource,
} from "./embedded-agent-utils.js";

/** Render native final-answer parts once for both terminal evidence and full completion text. */
export function prepareTerminalAssistantReply(assistant: AssistantTextSource | undefined) {
  const rawText = resolveRawAssistantAnswerText(assistant);
  const reply = prepareAgentRunTerminalReply({ rawText });
  if (assistant && reply.terminalReply.disposition !== "silent") {
    // Preserve native part boundaries for either edge selected by the reply owner.
    const prefixOnly = rawText.endsWith(reply.text);
    let remainingPrefix = prefixOnly ? rawText.length - reply.text.length : 0;
    let remainingLength = prefixOnly ? Infinity : reply.text.length;
    let nativeSourceText = "";
    const render = prepareAssistantVisibleText(assistant, (text) => {
      if (!prefixOnly) {
        nativeSourceText += text;
      }
      const removed = Math.min(remainingPrefix, text.length);
      remainingPrefix -= removed;
      const visible = text.slice(removed, removed + remainingLength);
      remainingLength -= visible.length;
      return visible;
    });
    reply.text =
      prefixOnly || nativeSourceText === rawText
        ? render()
        : extractAssistantVisibleText(assistant, (_text, final) => (final ? reply.text : ""));
    reply.terminalReply = sanitizeAgentRunTerminalReply(parseReplyDirectives(reply.text).text);
  }
  return reply;
}
