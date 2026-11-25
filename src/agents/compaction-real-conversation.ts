/**
 * Classifies transcript messages that contain real user-visible conversation
 * for compaction and history pruning.
 */
import { stripHeartbeatToken } from "../auto-reply/heartbeat.js";
import { isSilentAssistantTranscriptMessage } from "../shared/chat-message-content.js";
import { isToolCallBlockType } from "../shared/tool-block-contract.js";
import type { AgentMessage } from "./runtime/index.js";

const TOOL_RESULT_REAL_CONVERSATION_LOOKBACK = 20;
const NON_CONVERSATION_BLOCK_TYPES = new Set(["thinking", "reasoning"]);
const CONVERSATION_ANCHOR_ROLES = new Set([
  "user",
  "custom",
  "bashExecution",
  "branchSummary",
  "compactionSummary",
]);

export function hasMeaningfulConversationText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const heartbeat = stripHeartbeatToken(trimmed, { mode: "message" });
  return !heartbeat.didStrip || heartbeat.text.trim().length > 0;
}

/** Returns whether a message has content worth preserving as conversation. */
function hasMeaningfulConversationContent(message: AgentMessage): boolean {
  if ("excludeFromContext" in message && message.excludeFromContext === true) {
    return false;
  }
  if (isSilentAssistantTranscriptMessage(message)) {
    return false;
  }
  if ((message as { role?: unknown }).role === "custom") {
    const custom = message as { content?: unknown; display?: unknown };
    return custom.display !== false && hasMeaningfulMessageContent(custom.content);
  }
  if (message.role === "bashExecution") {
    const command = typeof message.command === "string" ? message.command : "";
    const output = typeof message.output === "string" ? message.output : "";
    return hasMeaningfulConversationText(`${command}\n${output}`);
  }
  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    const summary = message.summary;
    return typeof summary === "string" && hasMeaningfulConversationText(summary);
  }
  const content = (message as { content?: unknown }).content;
  return hasMeaningfulMessageContent(content);
}

function hasMeaningfulMessageContent(content: unknown): boolean {
  if (typeof content === "string") {
    return hasMeaningfulConversationText(content);
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some(collectMeaningfulConversationBlock);
}

export function collectMeaningfulConversationBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const { type, text } = block as { type?: unknown; text?: unknown };
  return type === "text"
    ? typeof text === "string" && hasMeaningfulConversationText(text)
    : !isToolCallBlockType(type) && !NON_CONVERSATION_BLOCK_TYPES.has(String(type));
}

export type RealConversationMessageFact = { real: boolean; anchor: boolean; toolResult: boolean };

/** Collect before releasing a payload; classification is rebased to each selected sequence. */
export function collectRealConversationMessageFact(
  message: AgentMessage,
): RealConversationMessageFact {
  const anchorRole = CONVERSATION_ANCHOR_ROLES.has(message.role);
  const meaningful =
    (anchorRole || message.role === "assistant") && hasMeaningfulConversationContent(message);
  return {
    real: meaningful,
    anchor: anchorRole && meaningful,
    toolResult: message.role === "toolResult",
  };
}

export function createRealConversationFactClassifier(): (
  fact: RealConversationMessageFact,
) => boolean {
  let anchorLookback = 0;
  return (fact) => {
    const real = fact.toolResult ? anchorLookback > 0 : fact.real;
    anchorLookback = fact.anchor
      ? TOOL_RESULT_REAL_CONVERSATION_LOOKBACK
      : Math.max(0, anchorLookback - 1);
    return real;
  };
}

/** Returns whether a transcript message should count as real conversation. */
export function isRealConversationMessage(
  message: AgentMessage,
  messages: AgentMessage[],
  index: number,
): boolean {
  const fact = collectRealConversationMessageFact(message);
  if (!fact.toolResult) {
    return fact.real;
  }
  const start = Math.max(0, index - TOOL_RESULT_REAL_CONVERSATION_LOOKBACK);
  for (let i = index - 1; i >= start; i -= 1) {
    const candidate = messages[i];
    if (candidate && collectRealConversationMessageFact(candidate).anchor) {
      return true;
    }
  }
  return false;
}

/** Classifies an ordered transcript without retaining earlier pages. */
export function createRealConversationClassifier(): (message: AgentMessage) => boolean {
  const classify = createRealConversationFactClassifier();
  return (message) => classify(collectRealConversationMessageFact(message));
}
