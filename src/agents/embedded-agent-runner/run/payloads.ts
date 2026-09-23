/**
 * Builds embedded-agent payload objects from attempt inputs and outcomes.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SourceReplyDeliveryMode } from "../../../auto-reply/get-reply-options.types.js";
import {
  createHeartbeatToolResponsePayload,
  type HeartbeatToolResponse,
} from "../../../auto-reply/heartbeat-tool-response.js";
import { buildProviderLoginRecovery } from "../../../auto-reply/provider-login-recovery.js";
import {
  copyReplyPayloadMetadata,
  getReplyPayloadMetadata,
  hasReplyPayloadSpeechContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayload,
  type ReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, ThinkLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import {
  HEARTBEAT_TOKEN,
  isSilentReplyPayloadText,
  SILENT_REPLY_TOKEN,
} from "../../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { hasReplyPayloadContent } from "../../../interactive/payload.js";
import type { AssistantMessage } from "../../../llm/types.js";
import { resolveRawAssistantAnswerText } from "../../../shared/assistant-answer-text.js";
import { trimTextPreservingCode } from "../../../shared/text/text-projection.js";
import { classifyOAuthRefreshFailure } from "../../auth-profiles/oauth-refresh-failure.js";
import {
  formatAssistantErrorText,
  formatUserFacingAssistantErrorText,
  normalizeTextForComparison,
} from "../../embedded-agent-helpers.js";
import { SYNTHESIZED_TIMEOUT_ERROR_TEXT } from "../../embedded-agent-helpers/error-text.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../../embedded-agent-messaging.types.js";
import type { EmbeddedAgentSubscribeState } from "../../embedded-agent-subscribe.handlers.types.js";
import type { ToolResultFormat } from "../../embedded-agent-subscribe.shared-types.js";
import {
  extractAssistantThinking,
  extractAssistantVisibleText,
  sanitizeAssistantVisibleStreamText,
} from "../../embedded-agent-utils.js";
import { isTimeoutErrorMessage } from "../../failover/classify.js";
import type { PreparedProviderFailoverOwner } from "../../failover/provider-patterns.js";
import type { ToolErrorSummary } from "../../tool-error-summary.js";
import {
  hasCompletedMessagingToolDeliveryEvidence,
  hasVisibleCommittedMessagingToolDeliveryEvidence,
} from "../delivery-evidence.js";
import { buildSourceReplyPayloadState } from "./source-reply-payloads.js";
import { buildFailureWarning } from "./tool-error-warning.js";

/**
 * Converts a completed embedded attempt into reply payloads for channels. This
 * is the boundary that suppresses duplicate source replies, filters raw API
 * errors, preserves directive metadata, and decides when tool failures must be
 * surfaced to the user.
 */
export function buildEmbeddedRunPayloads(params: {
  assistantTexts: string[];
  answerSegments?: EmbeddedAgentSubscribeState["answerSegments"];
  assistantMessageIndex?: number;
  assistantTranscriptOwned?: boolean;
  assistantTranscriptIdempotencyKey?: string;
  lastAssistant: AssistantMessage | undefined;
  currentAssistant?: AssistantMessage | null;
  lastToolError?: ToolErrorSummary;
  config?: OpenClawConfig;
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
  messagingToolSentTargets?: MessagingToolSend[];
  messagingToolSourceReplyPayloads?: MessagingToolSourceReplyPayload[];
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  agentId?: string;
  runId?: string;
  runAborted?: boolean;
  runStopReason?: string;
  deferAssistantTimeoutError?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  heartbeatToolResponse?: HeartbeatToolResponse;
}): ReplyPayload[] {
  const heartbeatTerminalToolFailure =
    params.isHeartbeatTrigger === true &&
    params.lastToolError &&
    params.lastToolError.mutatingAction === true
      ? { toolName: params.lastToolError.toolName }
      : undefined;
  if (
    params.heartbeatToolResponse &&
    (!heartbeatTerminalToolFailure || !params.heartbeatToolResponse.notify)
  ) {
    const payload = createHeartbeatToolResponsePayload(params.heartbeatToolResponse);
    // A quiet outcome controls notification, not success. Keep the failure in
    // scheduler diagnostics without replacing notify=false with a tool warning.
    if (heartbeatTerminalToolFailure) {
      setReplyPayloadMetadata(payload, { heartbeatTerminalToolFailure });
    }
    return [payload];
  }
  // Internal source replies always need transcript/UI mirrors. Only a
  // message_tool_only run suppresses the separate automatic final answer.
  const {
    replyItems,
    hasSourceReplyPayload,
    deliveredSourceReplyViaMessageTool,
    completedSourceReplyViaMessageTool,
  } = buildSourceReplyPayloadState({
    payloads: params.messagingToolSourceReplyPayloads,
    sentTargets: params.messagingToolSentTargets,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    didDeliverSourceReplyViaMessageTool: params.didDeliverSourceReplyViaMessageTool,
    runId: params.runId,
  });
  if (params.heartbeatToolResponse) {
    const heartbeatPayload = createHeartbeatToolResponsePayload(params.heartbeatToolResponse);
    replyItems.push({
      text: heartbeatPayload.text ?? "",
      ...(heartbeatPayload.channelData ? { channelData: heartbeatPayload.channelData } : {}),
    });
  }
  const useMarkdown = params.toolResultFormat === "markdown";
  const suppressAssistantArtifacts =
    params.heartbeatToolResponse !== undefined ||
    params.didSendDeterministicApprovalPrompt === true ||
    (params.sourceReplyDeliveryMode === "message_tool_only" && hasSourceReplyPayload) ||
    deliveredSourceReplyViaMessageTool;
  const suppressFailureArtifacts =
    params.didSendDeterministicApprovalPrompt === true ||
    (params.sourceReplyDeliveryMode === "message_tool_only" && completedSourceReplyViaMessageTool);
  let hasUserFacingReply =
    completedSourceReplyViaMessageTool || params.heartbeatToolResponse?.notify === true;
  let hasIntentionalSilentFinal = false;
  const appendSegmentAnswer = ({
    assistantTexts,
    lastAssistant,
    currentAssistant,
    assistantMessageIndex,
  }: Pick<
    typeof params,
    "assistantTexts" | "lastAssistant" | "currentAssistant" | "assistantMessageIndex"
  >) => {
    // Silence belongs to this input's answer. An earlier steered input must not
    // hide a later input that actually failed without producing an answer.
    hasIntentionalSilentFinal = false;
    const nonEmptyAssistantTexts = assistantTexts
      .map((text) => sanitizeAssistantVisibleStreamText(text))
      .filter((text) => text.trim().length > 0);
    const assistantForPayload =
      currentAssistant ?? (nonEmptyAssistantTexts.length === 1 ? undefined : lastAssistant);
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
    const errorText =
      assistantForPayload && lastAssistantNeedsErrorSurface
        ? suppressFailureArtifacts
          ? undefined
          : lastAssistantErrored || rawErrorMessage
            ? (providerLoginRecovery?.hint ??
              formatUserFacingAssistantErrorText(assistantForPayload, {
                cfg: params.config,
                sessionKey: params.sessionKey,
                agentId: params.agentId,
                provider: params.provider,
                providerOwner: params.providerOwner,
                model: params.model,
                authMode: params.authMode,
              }))
            : formatAssistantErrorText(assistantForPayload, {
                cfg: params.config,
                sessionKey: params.sessionKey,
                agentId: params.agentId,
                provider: params.provider,
                providerOwner: params.providerOwner,
                model: params.model,
                authMode: params.authMode,
              })
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
      replyItems.push(setReplyPayloadMetadata(errorPayload, { terminalProviderError: true }));
    }
    const reasoningText =
      suppressAssistantArtifacts || runAborted || lastAssistantNeedsErrorSurface
        ? ""
        : assistantForPayload && params.reasoningLevel === "on" && params.thinkingLevel !== "off"
          ? extractAssistantThinking(assistantForPayload)
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
        rawAnswerDirectiveState?.isSilent ||
        (rawAnswerHasMedia &&
          (!nonEmptyAssistantTexts.length ||
            (normalizedAssistantTexts.length > 0 &&
              normalizedAssistantTexts ===
                normalizeTextForComparison(rawAnswerDirectiveState?.text ?? ""))));
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
      const hasAssistantTextPayload = nonEmptyAssistantTexts.length > 0;
      const answerTexts =
        shouldUseCanonicalFinalAnswer || shouldPreferRawAnswerText
          ? [fallbackAnswerSourceText]
          : hasAssistantTextPayload
            ? nonEmptyAssistantTexts
            : fallbackAnswerText
              ? [fallbackAnswerText]
              : [];
      const preparedAnswerDirectives =
        shouldUseCanonicalFinalAnswer || shouldPreferRawAnswerText || !hasAssistantTextPayload
          ? fallbackAnswerDirectiveState
          : null;
      for (const text of answerTexts) {
        const {
          text: cleanedText,
          mediaUrls,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
          isSilent,
        } = preparedAnswerDirectives ?? parseReplyDirectives(text);
        hasIntentionalSilentFinal = isSilent;
        const ttsFacts = shouldUseCanonicalFinalAnswer ? storedDelivery?.tts : undefined;
        const delivery = shouldUseCanonicalFinalAnswer
          ? {
              audioAsVoice: storedDelivery?.audioAsVoice,
              replyToCurrent: storedDelivery?.replyToCurrent,
              replyToId: storedDelivery?.replyToId,
              replyToTag: Boolean(storedDelivery?.replyToCurrent || storedDelivery?.replyToId),
            }
          : { audioAsVoice, replyToId, replyToTag, replyToCurrent };
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
          media: mediaUrls,
          ...delivery,
        };
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
    });
    for (const reply of replyItems.slice(replyStart)) {
      setReplyPayloadMetadata(reply, { precedingInputAnswer: true });
    }
    textStart = segment.textEnd;
  }
  appendSegmentAnswer({
    assistantTexts: params.assistantTexts.slice(textStart),
    lastAssistant: params.lastAssistant,
    currentAssistant: params.currentAssistant,
    assistantMessageIndex: params.assistantMessageIndex,
  });
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
  if (params.lastToolError && !respectIntentionalSilence) {
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
        ? replyItems.some((item) => {
            if (!item.text) {
              return false;
            }
            const normalizedExisting = normalizeTextForComparison(item.text);
            return normalizedExisting.length > 0 && normalizedExisting === normalizedWarning;
          })
        : false;
      if (!duplicateWarning) {
        const warning = {
          text: warningText,
          ...(!isRestartStatus ? { isError: true } : {}),
        };
        if (!isRestartStatus) {
          setReplyPayloadMetadata(warning, {
            toolErrorWarning: { toolName: params.lastToolError.toolName },
          });
        }
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
        text: trimTextPreservingCode(item.text ?? "") || undefined,
      });
      const mediaUrl = item.mediaUrl ?? item.media?.[0];
      if (mediaUrl) {
        payload.mediaUrl = mediaUrl;
      }
      if (item.media?.length) {
        payload.mediaUrls = item.media;
      }
      if (item.attachments?.length) {
        payload.attachments = item.attachments;
      }
      if (item.trustedLocalMedia !== undefined) {
        payload.trustedLocalMedia = item.trustedLocalMedia;
      }
      if (item.isError !== undefined) {
        payload.isError = item.isError;
      }
      if (item.isReasoning === true) {
        payload.isReasoning = true;
      }
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
          ...(item.media?.length ? { assistantTranscriptMediaUrls: [...item.media] } : {}),
          ...(params.assistantTranscriptOwned === true ? { assistantTranscriptOwned: true } : {}),
          ...(params.assistantTranscriptIdempotencyKey
            ? {
                assistantTranscriptIdempotencyKey: params.assistantTranscriptIdempotencyKey,
              }
            : {}),
        });
      }
      if (item.replyToId) {
        payload.replyToId = item.replyToId;
      }
      if (item.replyToTag !== undefined) {
        payload.replyToTag = item.replyToTag;
      }
      if (item.replyToCurrent !== undefined) {
        payload.replyToCurrent = item.replyToCurrent;
      }
      if (item.audioAsVoice || Boolean(hasAudioAsVoiceTag && item.media?.length)) {
        payload.audioAsVoice = true;
      }
      if (item.presentation) {
        payload.presentation = item.presentation;
      }
      if (item.interactive) {
        payload.interactive = item.interactive;
      }
      if (item.channelData) {
        payload.channelData = item.channelData;
      }
      if (item.sourceReplyMirror) {
        // Source-reply mirrors are transcript artifacts, not channel sends.
        markReplyPayloadForSourceSuppressionDelivery(payload);
        if (params.sessionKey) {
          const sourceReplyTranscriptMirror: NonNullable<
            ReplyPayloadMetadata["sourceReplyTranscriptMirror"]
          > = {
            sessionKey: params.sessionKey,
          };
          if (params.agentId) {
            sourceReplyTranscriptMirror.agentId = params.agentId;
          }
          if (payload.text) {
            sourceReplyTranscriptMirror.text = payload.text;
          }
          if (payload.mediaUrls?.length) {
            sourceReplyTranscriptMirror.mediaUrls = payload.mediaUrls;
          }
          if (item.sourceReplyMirror.idempotencyKey) {
            sourceReplyTranscriptMirror.idempotencyKey = item.sourceReplyMirror.idempotencyKey;
          }
          if (item.sourceReplyMirror.transcriptOwner) {
            sourceReplyTranscriptMirror.transcriptOwner = true;
          }
          setReplyPayloadMetadata(payload, {
            sourceReplyTranscriptMirror,
          });
        }
      }
      if (payload.text && isSilentReplyPayloadText(payload.text, SILENT_REPLY_TOKEN)) {
        const silentText = payload.text;
        payload.text = undefined;
        if (hasReplyPayloadContent(payload) || hasReplyPayloadSpeechContent(payload)) {
          return payload;
        }
        payload.text = silentText;
      }
      return payload;
    })
    .filter((p) => {
      if (!hasReplyPayloadContent(p) && !hasReplyPayloadSpeechContent(p)) {
        return false;
      }
      if (p.text && isSilentReplyPayloadText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}
