import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { normalizeTextForComparison } from "./embedded-agent-helpers.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";

type AssistantTextAccumulatorParams = {
  params: Pick<SubscribeEmbeddedAgentSessionParams, "onBlockReply" | "silentExpected">;
  state: EmbeddedAgentSubscribeContext["state"];
};

export function createAssistantTextAccumulator({ params, state }: AssistantTextAccumulatorParams) {
  const assistantTexts = state.assistantTexts;

  const rememberAssistantText = (text: string, normalizedText?: string) => {
    state.lastAssistantTextMessageIndex = state.assistantMessageIndex;
    state.lastAssistantTextContentIndex = state.lastAssistantStreamContentIndex;
    state.lastAssistantTextItemId = state.lastAssistantStreamItemId;
    state.lastAssistantTextTrimmed = text.trimEnd();
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    state.lastAssistantTextNormalized = normalized.length > 0 ? normalized : undefined;
  };

  const shouldSkipAssistantText = (text: string, normalizedText?: string) => {
    // Distinct provider content blocks may legitimately contain identical text.
    if (
      state.lastAssistantTextMessageIndex !== state.assistantMessageIndex ||
      state.lastAssistantTextContentIndex !== state.lastAssistantStreamContentIndex
    ) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (trimmed && trimmed === state.lastAssistantTextTrimmed) {
      return true;
    }
    const normalized = normalizedText ?? normalizeTextForComparison(text);
    return normalized.length > 0 && normalized === state.lastAssistantTextNormalized;
  };

  const pushAssistantText = (text: string, normalizedText?: string) => {
    if (!text) {
      return;
    }
    if (params.silentExpected && !isSilentReplyText(text, SILENT_REPLY_TOKEN)) {
      return;
    }
    if (shouldSkipAssistantText(text, normalizedText)) {
      return;
    }
    assistantTexts.push(text);
    rememberAssistantText(text, normalizedText);
  };

  const replaceCurrentAssistantText = (text: string) => {
    const count = assistantTexts.length - state.assistantTextBaseline;
    if (!text) {
      assistantTexts.splice(state.assistantTextBaseline, count);
    } else if (count > 0) {
      assistantTexts.splice(state.assistantTextBaseline, count, text);
      rememberAssistantText(text);
    } else {
      pushAssistantText(text);
    }
  };

  const finalizeAssistantTexts = (args: {
    text: string;
    addedDuringMessage: boolean;
    chunkerHasBuffered: boolean;
    reconcileCurrentMessage?: boolean;
  }) => {
    const { text, addedDuringMessage, chunkerHasBuffered, reconcileCurrentMessage } = args;

    // A run-budget timeout flush may already have committed partial text for
    // this message. When message_end later finalizes the complete text, replace
    // the flushed partial instead of appending a duplicate. The partial stays
    // when message_end never arrives (hard run-budget abort) — that is the
    // salvage the timeout flush exists for.
    if (state.hasFlushedPartialText) {
      replaceCurrentAssistantText(text);
      state.hasFlushedPartialText = false;
      state.assistantTextBaseline = assistantTexts.length;
      return;
    }

    // If we're not streaming block replies, ensure the final payload includes
    // the final text even when interim streaming was enabled.
    if (reconcileCurrentMessage && addedDuringMessage) {
      replaceCurrentAssistantText(text);
    } else if (state.includeReasoning && text && !params.onBlockReply) {
      replaceCurrentAssistantText(text);
      state.suppressBlockChunks = true;
    } else if (!addedDuringMessage && !chunkerHasBuffered && text) {
      // Non-streaming models (no text_delta): ensure assistantTexts gets the final
      // text when the chunker has nothing buffered to drain.
      pushAssistantText(text);
    }

    state.assistantTextBaseline = assistantTexts.length;
  };

  return {
    finalizeAssistantTexts,
    pushAssistantText,
    replaceCurrentAssistantText,
    shouldSkipAssistantText,
  };
}
