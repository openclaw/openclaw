import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import { normalizeOptionalString } from "../../../shared/string-coerce.js";
import { normalizeTextForComparison } from "../../pi-embedded-helpers.js";
import { extractAssistantVisibleText, isAssistantMessage } from "../../pi-embedded-utils.js";
import { makeZeroUsageSnapshot, type NormalizedUsage } from "../../usage.js";

type SessionManagerAppender = Pick<SessionManager, "appendMessage">;

function persistedTextCoversAssistantText(persisted: string, candidate: string): boolean {
  const persistedNormalized = normalizeTextForComparison(persisted);
  const candidateNormalized = normalizeTextForComparison(candidate);
  if (!persistedNormalized || !candidateNormalized) {
    return false;
  }
  if (persistedNormalized === candidateNormalized) {
    return true;
  }
  return candidateNormalized.length >= 20 && persistedNormalized.includes(candidateNormalized);
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

function toAssistantUsageSnapshot(usage?: NormalizedUsage): Usage {
  const zero = makeZeroUsageSnapshot();
  if (!usage) {
    return zero;
  }
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    ...zero,
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: usage.total ?? input + output + cacheRead + cacheWrite,
  };
}

export function reconcileAssistantTextsWithTranscript(params: {
  sessionManager: SessionManagerAppender;
  messagesSnapshot: AgentMessage[];
  prePromptMessageCount: number;
  assistantTexts: readonly string[];
  provider: string;
  modelId: string;
  usage?: NormalizedUsage;
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
    usage: toAssistantUsageSnapshot(params.usage),
    stopReason: "stop",
    timestamp: params.timestamp ?? Date.now(),
  };
  params.sessionManager.appendMessage(message);
  params.messagesSnapshot.push(message);
  return message;
}
