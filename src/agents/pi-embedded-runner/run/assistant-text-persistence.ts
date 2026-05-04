import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { normalizeTextForComparison } from "../../pi-embedded-helpers.js";
import { extractAssistantVisibleText, isAssistantMessage } from "../../pi-embedded-utils.js";
import { makeZeroUsageSnapshot } from "../../usage.js";

type SessionManagerAppender = Pick<SessionManager, "appendMessage">;

const SHORT_SUBSTRING_COVERAGE_MAX_LENGTH = 16;

function normalizedTextSegments(text: string): string[] {
  return text
    .split(/(?:\r?\n)+|(?<=[.!?])\s+/u)
    .map((segment) => normalizeTextForComparison(segment))
    .filter(Boolean);
}

function persistedTextCoversAssistantText(persisted: string, candidate: string): boolean {
  const persistedNormalized = normalizeTextForComparison(persisted);
  const candidateNormalized = normalizeTextForComparison(candidate);
  if (!persistedNormalized || !candidateNormalized) {
    return false;
  }
  if (persistedNormalized === candidateNormalized) {
    return true;
  }
  if (candidateNormalized.length <= SHORT_SUBSTRING_COVERAGE_MAX_LENGTH) {
    return normalizedTextSegments(persisted).includes(candidateNormalized);
  }
  return persistedNormalized.includes(candidateNormalized);
}

function toPersistableAssistantText(text: string): string | undefined {
  return normalizeOptionalString(parseReplyDirectives(text).text);
}

export function resolveUnpersistedAssistantTexts(params: {
  assistantTexts: readonly string[];
  messagesSnapshot: readonly AgentMessage[];
  prePromptMessageCount: number;
}): string[] {
  const currentAttemptMessages = params.messagesSnapshot.slice(
    Math.max(0, params.prePromptMessageCount),
  );
  const persistedAssistantTexts = currentAttemptMessages
    .filter(isAssistantMessage)
    .map((message) => normalizeOptionalString(extractAssistantVisibleText(message)) ?? "")
    .filter(Boolean);

  return params.assistantTexts
    .map((text) => toPersistableAssistantText(text) ?? "")
    .filter(Boolean)
    .filter(
      (text) =>
        !persistedAssistantTexts.some((persisted) =>
          persistedTextCoversAssistantText(persisted, text),
        ),
    );
}

export function reconcileAssistantTextsWithTranscript(params: {
  sessionManager: SessionManagerAppender;
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  assistantTexts: readonly string[];
  provider: string;
  modelId: string;
  timestamp?: number;
}): AssistantMessage | undefined {
  const text = normalizeOptionalString(
    resolveUnpersistedAssistantTexts({
      assistantTexts: params.assistantTexts,
      messagesSnapshot: params.messagesSnapshot,
      prePromptMessageCount: params.prePromptMessageCount,
    }).join("\n\n"),
  );
  if (!text) {
    return undefined;
  }

  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: params.provider,
    model: params.modelId,
    usage: makeZeroUsageSnapshot(),
    stopReason: "stop",
    timestamp: params.timestamp ?? Date.now(),
  };
  params.sessionManager.appendMessage(message);
  params.messagesSnapshot.push(message);
  return message;
}
