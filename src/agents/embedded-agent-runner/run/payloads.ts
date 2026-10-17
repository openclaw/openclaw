import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../../../auto-reply/heartbeat-tool-response.js";
import { buildProviderLoginRecovery } from "../../../auto-reply/provider-login-recovery.js";
import {
  addReplyPayloadMediaFailures,
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  hasReplyPayloadSpeechContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
} from "../../../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import { HEARTBEAT_TOKEN } from "../../../auto-reply/tokens.js";
import { applyAssistantDeliveryDirectives } from "../../../config/sessions/transcript-assistant-delivery.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasReplyPayloadContent } from "../../../interactive/payload.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { resolveRawAssistantAnswerText } from "../../../shared/assistant-answer-text.js";
import { readAssistantTextBlocksForPhase } from "../../../shared/chat-message-content.js";
import { sanitizeAssistantVisibleText } from "../../../shared/text/assistant-visible-text.js";
import { trimTextPreservingCode } from "../../../shared/text/text-projection.js";
import { extractTtsDirectiveFacts } from "../../../tts/directive-facts.js";
import {
  prepareAgentRunTerminalReply,
  type PreparedAgentRunTerminalReply,
} from "../../agent-run-terminal-reply.js";
import { classifyOAuthRefreshFailure } from "../../auth-profiles/oauth-refresh-failure.js";
import {
  classifyAssistantFailoverReason,
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
  normalizeTextForComparison,
} from "../../embedded-agent-helpers.js";
import { SYNTHESIZED_TIMEOUT_ERROR_TEXT } from "../../embedded-agent-helpers/error-text.js";
import { sanitizeUserFacingText } from "../../embedded-agent-helpers/sanitize-user-facing-text.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { EmbeddedAgentSubscribeState } from "../../embedded-agent-subscribe.handlers.types.js";
import type { ToolResultFormat } from "../../embedded-agent-subscribe.shared-types.js";
import { isToolAuthoredSourceReplyForAssistant } from "../../embedded-agent-tool-authored-source-reply.js";
import {
  extractAssistantThinking,
  extractAssistantVisibleText,
} from "../../embedded-agent-utils.js";
import { isTimeoutErrorMessage } from "../../failover/classify.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import { renderRateLimitRetryExhaustion } from "../../failover/user-copy.js";
import type { ReplyDeliveryState } from "../../reply-completion.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import {
  hasCompletedMessagingToolDeliveryEvidence,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
} from "../delivery-evidence.js";
import { buildSourceReplyPayloadState } from "./source-reply-payloads.js";
import { buildFailureWarning } from "./tool-error-warning.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

function renderNativeAssistantReply(
  assistant: AssistantMessage,
  rawText: string,
  preparedText: string,
): string | undefined {
  if (!Array.isArray(assistant.content) || assistant.content.length < 2) {
    return undefined;
  }
  const finalBlocks = readAssistantTextBlocksForPhase(assistant, "final_answer");
  const sourceBlocks = finalBlocks.length
    ? finalBlocks
    : readAssistantTextBlocksForPhase(assistant);
  const prefixLength = rawText.endsWith(preparedText) ? rawText.length - preparedText.length : 0;
  // Only project native parts when they still represent the authoritative prepared source.
  if (
    sourceBlocks.map((block) => block.text).join("") !== rawText ||
    (prefixLength === 0 && !rawText.startsWith(preparedText))
  ) {
    return undefined;
  }
  const rendered = {
    ...assistant,
    content: assistant.content.map((block) => ({ ...block })),
  };
  if (rawText !== preparedText) {
    // Map the prepared range before directives consume bytes from the native parts.
    let remainingPrefix = prefixLength;
    let remainingLength = preparedText.length;
    for (const block of readAssistantTextBlocksForPhase(
      rendered,
      finalBlocks.length ? "final_answer" : undefined,
    )) {
      const removed = Math.min(remainingPrefix, block.text.length);
      remainingPrefix -= removed;
      block.text = block.text.slice(removed, removed + remainingLength);
      remainingLength -= block.text.length;
    }
  }
  // Native part boundaries carry fence context that is lost after joining the text.
  applyAssistantDeliveryDirectives(rendered);
  return extractAssistantVisibleText(rendered);
}

/**
 * Converts a completed embedded attempt into reply payloads for channels. This
 * is the boundary that suppresses duplicate source replies, filters raw API
 * errors, preserves directive metadata, and decides when tool failures must be
 * surfaced to the user.
 */
export function buildEmbeddedRunPayloads(params: {
  assistantTexts: string[];
  preparedTerminalReply?: PreparedAgentRunTerminalReply;
  answerSegments?: EmbeddedAgentSubscribeState["answerSegments"];
  keptAnswer?: EmbeddedAgentSubscribeState["keptAnswer"];
  assistantMessageIndex?: number;
  assistantTranscriptOwned?: boolean;
  assistantTranscriptIdempotencyKey?: string;
  lastAssistant: AssistantMessage | undefined;
  currentAssistant?: AssistantMessage | null;
  lastToolError?: ToolErrorSummary;
  config?: OpenClawConfig;
  sandboxRuntime?: EmbeddedRunAttemptResult["sandboxRuntime"];
  isCronTrigger?: boolean;
  isHeartbeatTrigger?: boolean;
  sessionKey: string;
  provider?: string;
  providerOwner?: PreparedProviderFailoverOwner;
  model?: string;
  /** Credential auth mode for billing copy (#80877). */
  authMode?: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  thinkingLevel?: ThinkLevel;
  toolResultFormat?: ToolResultFormat;
  didSendViaMessagingTool?: boolean;
  didDeliverSourceReplyViaMessageTool?: boolean;
  sourceReplyDeliveryState?: ReplyDeliveryState;
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  agentId?: string;
  runId?: string;
  runAborted?: boolean;
  runStopReason?: string;
  deferAssistantTimeoutError?: boolean;
  rateLimitRetriesExhausted?: number;
  didSendDeterministicApprovalPrompt?: boolean;
  heartbeatToolResponse?: HeartbeatToolResponse;
}): ReplyPayload[] {
  const sourceReplyPending = params.sourceReplyDeliveryState === "pending";
  const heartbeatToolResponse = sourceReplyPending ? undefined : params.heartbeatToolResponse;
  const heartbeatTerminalToolFailure =
    !sourceReplyPending &&
    params.isHeartbeatTrigger === true &&
    params.lastToolError &&
    params.lastToolError.mutatingAction === true
      ? { toolName: params.lastToolError.toolName }
      : undefined;
  if (heartbeatToolResponse && !heartbeatTerminalToolFailure) {
    return [createHeartbeatToolResponsePayload(heartbeatToolResponse)];
  }
  // Internal source replies always need transcript/UI mirrors. A committed
  // tool-authored batch replaces the model answer in either delivery mode.
  const sourceReplyStateFor = (payloads: MessagingToolSourceReplyPayload[]) =>
    buildSourceReplyPayloadState({
      ...params,
      payloads,
      sentTargets: params.messagingToolSentTargets,
    });
  const sourceReplies = params.messagingToolSourceReplyPayloads ?? [];
  const ordinarySourceReplies = sourceReplyStateFor(
    sourceReplies.filter((payload) => !payload.toolAuthored),
  );
  const replyItems = ordinarySourceReplies.replyItems;
  const pendingAuthoredReplies = new Set(sourceReplies.filter((payload) => payload.toolAuthored));
  if (heartbeatToolResponse) {
    const heartbeatPayload = createHeartbeatToolResponsePayload(heartbeatToolResponse);
    replyItems.push({
      text: heartbeatPayload.text ?? "",
      ...(heartbeatPayload.channelData ? { channelData: heartbeatPayload.channelData } : {}),
    });
  }
  const useMarkdown = params.toolResultFormat === "markdown";
  let suppressFailureArtifacts = false;
  let hasUserFacingReply = false;
  let hasIntentionalSilentFinal = false;
  const appendSegmentAnswer = ({
    assistantTexts,
    lastAssistant,
    currentAssistant,
    assistantMessageIndex: terminalMessageIndex,
    keptAnswer,
    sourceReplyDeliveryState,
    rateLimitRetriesExhausted,
  }: Pick<
    typeof params,
    | "assistantTexts"
    | "lastAssistant"
    | "currentAssistant"
    | "assistantMessageIndex"
    | "keptAnswer"
    | "sourceReplyDeliveryState"
    | "rateLimitRetriesExhausted"
  >) => {
    // Delivery receipts span the attempt; canonical completion belongs to one input.
    const completedSourceReplyViaMessageTool =
      sourceReplyDeliveryState !== undefined
        ? sourceReplyDeliveryState === "delivered"
        : ordinarySourceReplies.completedSourceReplyViaMessageTool;
    const deliveredSourceReplyViaMessageTool =
      sourceReplyDeliveryState !== undefined
        ? completedSourceReplyViaMessageTool
        : ordinarySourceReplies.deliveredSourceReplyViaMessageTool;
    const suppressAssistantArtifacts =
      heartbeatToolResponse !== undefined ||
      params.didSendDeterministicApprovalPrompt === true ||
      (params.sourceReplyDeliveryMode === "message_tool_only" &&
        ordinarySourceReplies.hasSourceReplyPayload) ||
      (deliveredSourceReplyViaMessageTool &&
        (params.sourceReplyDeliveryMode === "message_tool_only" ||
          completedSourceReplyViaMessageTool));
    suppressFailureArtifacts =
      params.didSendDeterministicApprovalPrompt === true || completedSourceReplyViaMessageTool;
    // Silence belongs to this input's answer. An earlier steered input must not
    // hide a later input that actually failed without producing an answer.
    hasIntentionalSilentFinal = false;
    hasUserFacingReply =
      completedSourceReplyViaMessageTool || heartbeatToolResponse?.notify === true;
    const authoredReplies = [...pendingAuthoredReplies].filter((payload) =>
      isToolAuthoredSourceReplyForAssistant(payload, currentAssistant ?? lastAssistant),
    );
    if (authoredReplies.length > 0) {
      for (const payload of authoredReplies) {
        pendingAuthoredReplies.delete(payload);
      }
      replyItems.push(...sourceReplyStateFor(authoredReplies).replyItems);
      hasUserFacingReply = true;
      return;
    }
    // Unresolved delivery retains custody; it cannot authorize a replacement answer or error.
    if (sourceReplyDeliveryState === "pending") {
      return;
    }
    const assistantTextSources = assistantTexts
      .map((rawText) => ({
        rawText,
        text: sanitizeUserFacingText(sanitizeAssistantVisibleText(rawText), {
          errorContext: false,
        }),
      }))
      .filter(({ text }) => text.trim().length > 0);
    const nonEmptyAssistantTexts = assistantTextSources.map(({ text }) => text);
    const terminalAssistant =
      currentAssistant ?? (nonEmptyAssistantTexts.length === 1 ? undefined : lastAssistant);
    // The subscriber decides when an earlier completed answer stays the reply. Only the answer
    // lane is restored; its reasoning was emitted at its own message_end.
    const assistantForPayload = keptAnswer?.assistant ?? terminalAssistant;
    const assistantMessageIndex = keptAnswer?.messageIndex ?? terminalMessageIndex;
    // Pre-upgrade recovered messages have no stored facts, and recovery intentionally does not
    // reparse text; one in-flight reply can lose delivery or speech intent across this boundary.
    const storedDelivery = assistantForPayload?.openclawDelivery;
    const lastAssistantStopReason = assistantForPayload?.stopReason;
    const lastAssistantErrored = lastAssistantStopReason === "error";
    const lastAssistantAborted = lastAssistantStopReason === "aborted";
    const runAborted = params.runAborted === true || lastAssistantAborted;
    const lastAssistantNeedsErrorSurface = lastAssistantErrored || lastAssistantAborted;
    const rawErrorMessage = lastAssistantNeedsErrorSurface
      ? normalizeOptionalString(assistantForPayload?.errorMessage)
      : undefined;
    const oauthRefreshFailure = rawErrorMessage
      ? classifyOAuthRefreshFailure(rawErrorMessage)
      : null;
    const providerLoginRecovery = buildProviderLoginRecovery({
      provider: oauthRefreshFailure?.provider ?? params.provider,
      oauthReason: oauthRefreshFailure?.reason,
    });
    const errorContext = {
      cfg: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      provider: params.provider,
      providerOwner: params.providerOwner,
      model: params.model,
      authMode: params.authMode,
      sandboxRuntime: params.sandboxRuntime,
    };
    const errorText =
      assistantForPayload && lastAssistantNeedsErrorSurface
        ? suppressFailureArtifacts
          ? undefined
          : lastAssistantErrored || rawErrorMessage
            ? (providerLoginRecovery?.hint ??
              renderRateLimitRetryExhaustion(rateLimitRetriesExhausted) ??
              formatUserFacingAssistantErrorText(assistantForPayload, errorContext))
            : formatAssistantErrorText(assistantForPayload, errorContext)
        : undefined;
    const deferAssistantTimeoutError =
      params.deferAssistantTimeoutError === true &&
      rawErrorMessage !== undefined &&
      isTimeoutErrorMessage(rawErrorMessage) &&
      errorText === SYNTHESIZED_TIMEOUT_ERROR_TEXT;
    if (errorText && !deferAssistantTimeoutError) {
      const errorPayload = {
        text: errorText,
        isError: true,
        ...(providerLoginRecovery ? { presentation: providerLoginRecovery.presentation } : {}),
      };
      replyItems.push(
        setReplyPayloadMetadata(errorPayload, {
          terminalProviderError: true,
          ...(assistantForPayload &&
          (rawErrorMessage ||
            assistantForPayload.errorCode ||
            assistantForPayload.errorType ||
            assistantForPayload.errorBody)
            ? {
                providerFailure: {
                  reason: classifyAssistantFailoverReason(assistantForPayload, errorContext),
                  rawError: rawErrorMessage,
                  rateLimitRetriesExhausted,
                },
              }
            : {}),
        }),
      );
    }
    const reasoningText =
      suppressAssistantArtifacts || runAborted || lastAssistantNeedsErrorSurface
        ? ""
        : terminalAssistant && params.reasoningLevel === "on" && params.thinkingLevel !== "off"
          ? extractAssistantThinking(terminalAssistant)
          : "";
    if (reasoningText) {
      replyItems.push({ text: reasoningText, isReasoning: true });
    }
    hasUserFacingReply ||= Boolean(errorText);
    if (!suppressAssistantArtifacts && !runAborted && !lastAssistantNeedsErrorSurface) {
      const fallbackAnswerText = assistantForPayload
        ? extractAssistantVisibleText(assistantForPayload)
        : "";
      const fallbackRawAnswerText = resolveRawAssistantAnswerText(assistantForPayload);
      const rawAnswerDirectiveState = fallbackRawAnswerText
        ? parseReplyDirectives(fallbackRawAnswerText)
        : null;
      const rawAnswerHasMedia =
        (rawAnswerDirectiveState?.mediaUrls?.length ?? 0) > 0 ||
        rawAnswerDirectiveState?.audioAsVoice;
      const normalizedAssistantTexts =
        rawAnswerHasMedia &&
        nonEmptyAssistantTexts.length > 0 &&
        !assistantTexts.some((text) => {
          const parsed = parseReplyDirectives(text);
          return (parsed.mediaUrls?.length ?? 0) > 0 || parsed.audioAsVoice;
        })
          ? normalizeTextForComparison(nonEmptyAssistantTexts.join("\n\n"))
          : "";
      const shouldPreferRawAnswerText =
        rawAnswerHasMedia &&
        (!nonEmptyAssistantTexts.length ||
          (normalizedAssistantTexts.length > 0 &&
            normalizedAssistantTexts ===
              normalizeTextForComparison(rawAnswerDirectiveState?.text ?? "")));
      // When streamed text lost media directives but the canonical assistant answer
      // still contains them, keep the raw answer so attachments are not dropped.
      const fallbackAnswerSourceText =
        shouldPreferRawAnswerText && fallbackRawAnswerText
          ? fallbackRawAnswerText
          : fallbackAnswerText;
      const fallbackAnswerDirectiveState =
        fallbackAnswerSourceText === fallbackRawAnswerText
          ? rawAnswerDirectiveState
          : fallbackAnswerSourceText
            ? parseReplyDirectives(fallbackAnswerSourceText)
            : null;
      const shouldUseCanonicalFinalAnswer = Boolean(
        (fallbackAnswerDirectiveState &&
          (normalizeTextForComparison(fallbackAnswerDirectiveState.text) ||
            fallbackAnswerDirectiveState.mediaUrls?.length)) ||
        storedDelivery?.tts?.text?.trim(),
      );
      // An empty canonical terminal is still authoritative; accumulated text may precede tools.
      const answerDirectives =
        shouldUseCanonicalFinalAnswer || shouldPreferRawAnswerText
          ? [fallbackAnswerDirectiveState ?? parseReplyDirectives(fallbackAnswerSourceText)]
          : !assistantForPayload && nonEmptyAssistantTexts.length > 0
            ? nonEmptyAssistantTexts.map((text) => parseReplyDirectives(text))
            : fallbackAnswerDirectiveState
              ? [fallbackAnswerDirectiveState]
              : [];
      for (const [answerIndex, directives] of answerDirectives.entries()) {
        const { mediaUrls, mediaFailures } = directives;
        const existingPrepared =
          assistantForPayload &&
          assistantForPayload ===
            (params.keptAnswer?.assistant ?? params.currentAssistant ?? params.lastAssistant)
            ? params.preparedTerminalReply
            : undefined;
        const prepared =
          existingPrepared ??
          prepareAgentRunTerminalReply({
            rawText:
              fallbackRawAnswerText ||
              assistantTextSources[answerIndex]?.rawText ||
              directives.text,
          });
        const nativeReply = assistantForPayload
          ? renderNativeAssistantReply(assistantForPayload, fallbackRawAnswerText, prepared.text)
          : undefined;
        const renderedText =
          nativeReply ??
          (existingPrepared
            ? prepared.text
            : assistantForPayload
              ? extractAssistantVisibleText(assistantForPayload, (_text, final) =>
                  final ? prepared.text : "",
                )
              : sanitizeUserFacingText(sanitizeAssistantVisibleText(prepared.text), {
                  errorContext: false,
                }));
        const ttsFacts = shouldUseCanonicalFinalAnswer ? storedDelivery?.tts : undefined;
        const cleanedText = parseReplyDirectives(
          ttsFacts ? extractTtsDirectiveFacts(renderedText).cleanedText : renderedText,
        ).text;
        hasIntentionalSilentFinal = prepared.terminalReply.disposition === "silent";
        const delivery = shouldUseCanonicalFinalAnswer
          ? {
              audioAsVoice: storedDelivery?.audioAsVoice,
              replyToCurrent: storedDelivery?.replyToCurrent,
              replyToId: storedDelivery?.replyToId,
              replyToTag: Boolean(storedDelivery?.replyToCurrent || storedDelivery?.replyToId),
            }
          : directives;
        if (
          !cleanedText &&
          (!mediaUrls || mediaUrls.length === 0) &&
          !delivery.audioAsVoice &&
          !ttsFacts
        ) {
          continue;
        }
        const replyPayload = {
          text: cleanedText,
          ...(mediaUrls?.[0] ? { mediaUrl: mediaUrls[0] } : {}),
          ...(mediaUrls?.length ? { mediaUrls } : {}),
          ...(delivery.audioAsVoice ? { audioAsVoice: true } : {}),
          ...(delivery.replyToId ? { replyToId: delivery.replyToId } : {}),
          ...(delivery.replyToTag !== undefined ? { replyToTag: delivery.replyToTag } : {}),
          ...(delivery.replyToCurrent !== undefined
            ? { replyToCurrent: delivery.replyToCurrent }
            : {}),
        };
        addReplyPayloadMediaFailures(replyPayload, mediaFailures);
        if (assistantMessageIndex !== undefined) {
          setReplyPayloadMetadata(replyPayload, { assistantMessageIndex });
        }
        replyItems.push(
          ttsFacts ? setReplyPayloadMetadata(replyPayload, { tts: ttsFacts }) : replyPayload,
        );
        hasUserFacingReply = true;
      }
    }
  };
  let textStart = 0;
  for (const segment of params.answerSegments ?? []) {
    const replyStart = replyItems.length;
    appendSegmentAnswer({
      assistantTexts: params.assistantTexts.slice(textStart, segment.textEnd),
      lastAssistant: segment.lastAssistant,
      currentAssistant: segment.lastAssistant,
      assistantMessageIndex: segment.messageEnd,
      keptAnswer: segment.keptAnswer,
      sourceReplyDeliveryState: segment.sourceReplyDeliveryState,
    });
    for (const reply of replyItems.slice(replyStart)) {
      setReplyPayloadMetadata(reply, { precedingInputAnswer: true });
    }
    textStart = segment.textEnd;
  }
  appendSegmentAnswer({ ...params, assistantTexts: params.assistantTexts.slice(textStart) });
  // Native projections with no assistant text still deliver their committed reply.
  replyItems.push(...sourceReplyStateFor([...pendingAuthoredReplies]).replyItems);
  // A conversational NO_REPLY is an authored outcome, not a missing answer.
  // Native shell calls are conservatively classified as mutating even when
  // they only search files. That replay-safety classification must not replace
  // a completed answer with a synthetic warning. A scheduled report can also
  // finish silently after a confirmed completed message-tool delivery. Progress
  // updates alone must not suppress a scheduled task's failure reporting.
  const respectIntentionalSilence =
    hasIntentionalSilentFinal &&
    (!params.isCronTrigger ||
      (hasVisibleCommittedMessagingToolDeliveryEvidence(params) &&
        hasCompletedMessagingToolDeliveryEvidence(params))) &&
    !params.isHeartbeatTrigger &&
    !params.runAborted;
  if (params.lastToolError && !respectIntentionalSilence && !sourceReplyPending) {
    // A restart intentionally aborts the active tool while the Gateway takes over.
    // Report the lifecycle status instead of a tool failure.
    const isRestartStatus = params.runStopReason === "restart";
    const warningText = isRestartStatus
      ? "Gateway restarting…"
      : buildFailureWarning({
          lastToolError: params.lastToolError,
          hasUserFacingReply,
          verboseLevel: params.verboseLevel,
          useMarkdown,
        });
    if (warningText) {
      const normalizedWarning = normalizeTextForComparison(warningText);
      const duplicateWarning = normalizedWarning
        ? replyItems.some(
            (item) => item.text && normalizeTextForComparison(item.text) === normalizedWarning,
          )
        : false;
      if (!duplicateWarning) {
        const warning = {
          text: warningText,
          ...(!isRestartStatus ? { isError: true } : {}),
        };
        setReplyPayloadMetadata(
          warning,
          isRestartStatus
            ? { hostNotice: true }
            : { toolErrorWarning: { toolName: params.lastToolError.toolName } },
        );
        replyItems.push(warning);
      }
    }
  }
  if (heartbeatTerminalToolFailure && !replyItems.some((item) => item.isReasoning !== true)) {
    replyItems.push({ text: HEARTBEAT_TOKEN });
  }
  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => {
      const assistantMessageIndex =
        getReplyPayloadMetadata(item)?.assistantMessageIndex ?? params.assistantMessageIndex;
      const payload: ReplyPayload = copyReplyPayloadMetadata(item, {
        ...item,
        text: trimTextPreservingCode(item.text ?? "") || undefined,
      });
      if (
        item.isError === true &&
        params.sourceReplyDeliveryMode === "message_tool_only" &&
        !suppressFailureArtifacts
      ) {
        markReplyPayloadForSourceSuppressionDelivery(payload);
      }
      if (heartbeatTerminalToolFailure) {
        setReplyPayloadMetadata(payload, {
          heartbeatTerminalToolFailure,
        });
      }
      if (
        !item.isError &&
        !item.isReasoning &&
        (assistantMessageIndex !== undefined || params.assistantTranscriptOwned === true)
      ) {
        setReplyPayloadMetadata(payload, {
          ...(assistantMessageIndex !== undefined ? { assistantMessageIndex } : {}),
          ...(item.mediaUrls?.length ? { assistantTranscriptMediaUrls: [...item.mediaUrls] } : {}),
          ...(params.assistantTranscriptOwned === true ? { assistantTranscriptOwned: true } : {}),
          ...(params.assistantTranscriptIdempotencyKey
            ? {
                assistantTranscriptIdempotencyKey: params.assistantTranscriptIdempotencyKey,
              }
            : {}),
        });
      }
      if (hasAudioAsVoiceTag && item.mediaUrls?.length) {
        payload.audioAsVoice = true;
      }
      return payload;
    })
    .filter((payload) => hasReplyPayloadContent(payload) || hasReplyPayloadSpeechContent(payload));
}
