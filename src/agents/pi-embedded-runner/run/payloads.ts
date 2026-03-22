import type { AssistantMessage } from "@mariozechner/pi-ai";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import { formatToolAggregate } from "../../../auto-reply/tool-meta.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  BILLING_ERROR_USER_MESSAGE,
  formatAssistantErrorText,
  formatRawAssistantErrorForUi,
  getApiErrorPayloadFingerprint,
  isRawApiErrorPayload,
  normalizeTextForComparison,
} from "../../pi-embedded-helpers.js";
import type { ToolResultFormat } from "../../pi-embedded-subscribe.js";
import {
  extractAssistantText,
  extractAssistantThinking,
  formatReasoningMessage,
} from "../../pi-embedded-utils.js";
import { isLikelyMutatingToolName } from "../../tool-mutation.js";

type ToolMetaEntry = { toolName: string; meta?: string };
type LastToolError = {
  toolName: string;
  meta?: string;
  error?: string;
  mutatingAction?: boolean;
  actionFingerprint?: string;
};
type ToolErrorWarningPolicy = {
  showWarning: boolean;
  includeDetails: boolean;
};
type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  isReasoning?: boolean;
  audioAsVoice?: boolean;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
};
type ResolvedAssistantErrorState = {
  errorText?: string;
  rawErrorMessage?: string;
  rawErrorFingerprint: string | null;
  formattedRawErrorMessage: string | null;
  normalizedFormattedRawErrorMessage: string | null;
  normalizedRawErrorText: string | null;
  normalizedErrorText: string | null;
};

const RECOVERABLE_TOOL_ERROR_KEYWORDS = [
  "required",
  "missing",
  "invalid",
  "must be",
  "must have",
  "needs",
  "requires",
] as const;

function isRecoverableToolError(error: string | undefined): boolean {
  const errorLower = (error ?? "").toLowerCase();
  return RECOVERABLE_TOOL_ERROR_KEYWORDS.some((keyword) => errorLower.includes(keyword));
}

function isVerboseToolDetailEnabled(level?: VerboseLevel): boolean {
  return level === "on" || level === "full";
}

function resolveToolErrorWarningPolicy(params: {
  lastToolError: LastToolError;
  hasUserFacingReply: boolean;
  suppressToolErrors: boolean;
  suppressToolErrorWarnings?: boolean;
  verboseLevel?: VerboseLevel;
}): ToolErrorWarningPolicy {
  const includeDetails = isVerboseToolDetailEnabled(params.verboseLevel);
  if (params.suppressToolErrorWarnings) {
    return { showWarning: false, includeDetails };
  }
  const normalizedToolName = params.lastToolError.toolName.trim().toLowerCase();
  if ((normalizedToolName === "exec" || normalizedToolName === "bash") && !includeDetails) {
    return { showWarning: false, includeDetails };
  }
  // sessions_send timeouts and errors are transient inter-session communication
  // issues — the message may still have been delivered. Suppress warnings to
  // prevent raw error text from leaking into the chat surface (#23989).
  if (normalizedToolName === "sessions_send") {
    return { showWarning: false, includeDetails };
  }
  const isMutatingToolError =
    params.lastToolError.mutatingAction ?? isLikelyMutatingToolName(params.lastToolError.toolName);
  if (isMutatingToolError) {
    return { showWarning: true, includeDetails };
  }
  if (params.suppressToolErrors) {
    return { showWarning: false, includeDetails };
  }
  return {
    showWarning: !params.hasUserFacingReply && !isRecoverableToolError(params.lastToolError.error),
    includeDetails,
  };
}

export function buildEmbeddedRunPayloads(params: {
  assistantTexts: string[];
  toolMetas: ToolMetaEntry[];
  lastAssistant: AssistantMessage | undefined;
  lastErroredAssistant?: AssistantMessage;
  lastToolError?: LastToolError;
  config?: OpenClawConfig;
  sessionKey: string;
  provider?: string;
  model?: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  suppressToolErrorWarnings?: boolean;
  inlineToolResultsAllowed: boolean;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
}): ReplyPayload[] {
  const replyItems: Array<{
    text: string;
    media?: string[];
    isError?: boolean;
    isReasoning?: boolean;
    audioAsVoice?: boolean;
    replyToId?: string;
    replyToTag?: boolean;
    replyToCurrent?: boolean;
  }> = [];

  const useMarkdown = params.toolResultFormat === "markdown";
  const suppressAssistantArtifacts = params.didSendDeterministicApprovalPrompt === true;
  const fallbackAnswerText = params.lastAssistant ? extractAssistantText(params.lastAssistant) : "";
  const rawAnswerTexts = suppressAssistantArtifacts
    ? []
    : params.assistantTexts.length
      ? params.assistantTexts
      : fallbackAnswerText
        ? [fallbackAnswerText]
        : [];
  const activeErrorAssistant = resolveEmbeddedRunPayloadErrorAssistant(params);
  const activeErrorState = resolveAssistantErrorState(activeErrorAssistant, params);
  const shouldSuppressRawErrorText = createRawErrorSuppressor(activeErrorState);
  const genericErrorText = "The AI service returned an error. Please try again.";
  const normalizedGenericBillingErrorText = normalizeTextForComparison(BILLING_ERROR_USER_MESSAGE);

  if (activeErrorState.errorText) {
    replyItems.push({ text: activeErrorState.errorText, isError: true });
  }

  const inlineToolResults =
    params.inlineToolResultsAllowed && params.verboseLevel !== "off" && params.toolMetas.length > 0;
  if (inlineToolResults) {
    for (const { toolName, meta } of params.toolMetas) {
      const agg = formatToolAggregate(toolName, meta ? [meta] : [], {
        markdown: useMarkdown,
      });
      const {
        text: cleanedText,
        mediaUrls,
        audioAsVoice,
        replyToId,
        replyToTag,
        replyToCurrent,
      } = parseReplyDirectives(agg);
      if (cleanedText) {
        replyItems.push({
          text: cleanedText,
          media: mediaUrls,
          audioAsVoice,
          replyToId,
          replyToTag,
          replyToCurrent,
        });
      }
    }
  }

  const reasoningText = suppressAssistantArtifacts
    ? ""
    : params.lastAssistant && params.reasoningLevel === "on"
      ? formatReasoningMessage(extractAssistantThinking(params.lastAssistant))
      : "";
  if (reasoningText) {
    replyItems.push({ text: reasoningText, isReasoning: true });
  }

  const answerTexts = rawAnswerTexts.filter((text) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (!activeErrorAssistant) {
      return true;
    }
    if (shouldSuppressRawErrorText(trimmed)) {
      return false;
    }
    const normalized = normalizeTextForComparison(trimmed);
    if (
      activeErrorState.normalizedErrorText &&
      normalized === activeErrorState.normalizedErrorText
    ) {
      return false;
    }
    if (trimmed === genericErrorText) {
      return false;
    }
    if (
      normalized &&
      normalizedGenericBillingErrorText &&
      normalized === normalizedGenericBillingErrorText
    ) {
      return false;
    }
    return true;
  });

  let hasUserFacingAssistantReply = false;
  for (const text of answerTexts) {
    const {
      text: cleanedText,
      mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    } = parseReplyDirectives(text);
    if (!cleanedText && (!mediaUrls || mediaUrls.length === 0) && !audioAsVoice) {
      continue;
    }
    replyItems.push({
      text: cleanedText,
      media: mediaUrls,
      audioAsVoice,
      replyToId,
      replyToTag,
      replyToCurrent,
    });
    hasUserFacingAssistantReply = true;
  }

  if (params.lastToolError) {
    const warningPolicy = resolveToolErrorWarningPolicy({
      lastToolError: params.lastToolError,
      hasUserFacingReply: hasUserFacingAssistantReply,
      suppressToolErrors: Boolean(params.config?.messages?.suppressToolErrors),
      suppressToolErrorWarnings: params.suppressToolErrorWarnings,
      verboseLevel: params.verboseLevel,
    });

    // Always surface mutating tool failures so we do not silently confirm actions that did not happen.
    // Otherwise, keep the previous behavior and only surface non-recoverable failures when no reply exists.
    if (warningPolicy.showWarning) {
      const toolSummary = formatToolAggregate(
        params.lastToolError.toolName,
        params.lastToolError.meta ? [params.lastToolError.meta] : undefined,
        { markdown: useMarkdown },
      );
      const errorSuffix =
        warningPolicy.includeDetails && params.lastToolError.error
          ? `: ${params.lastToolError.error}`
          : "";
      const warningText = `⚠️ ${toolSummary} failed${errorSuffix}`;
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
        replyItems.push({
          text: warningText,
          isError: true,
        });
      }
    }
  }

  const hasAudioAsVoiceTag = replyItems.some((item) => item.audioAsVoice);
  return replyItems
    .map((item) => ({
      text: item.text?.trim() ? item.text.trim() : undefined,
      mediaUrls: item.media?.length ? item.media : undefined,
      mediaUrl: item.media?.[0],
      isError: item.isError,
      replyToId: item.replyToId,
      replyToTag: item.replyToTag,
      replyToCurrent: item.replyToCurrent,
      audioAsVoice: item.audioAsVoice || Boolean(hasAudioAsVoiceTag && item.media?.length),
    }))
    .filter((p) => {
      if (!p.text && !p.mediaUrl && (!p.mediaUrls || p.mediaUrls.length === 0)) {
        return false;
      }
      if (p.text && isSilentReplyText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}

export function resolveEmbeddedRunPayloadErrorAssistant(params: {
  assistantTexts: string[];
  toolMetas: ToolMetaEntry[];
  lastAssistant: AssistantMessage | undefined;
  lastErroredAssistant?: AssistantMessage;
  lastToolError?: LastToolError;
  config?: OpenClawConfig;
  sessionKey: string;
  provider?: string;
  model?: string;
  verboseLevel?: VerboseLevel;
  reasoningLevel?: ReasoningLevel;
  toolResultFormat?: ToolResultFormat;
  suppressToolErrorWarnings?: boolean;
  inlineToolResultsAllowed: boolean;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
}): AssistantMessage | undefined {
  const suppressAssistantArtifacts = params.didSendDeterministicApprovalPrompt === true;
  if (suppressAssistantArtifacts) {
    return undefined;
  }
  if (params.lastAssistant?.stopReason === "error") {
    return params.lastAssistant;
  }
  const fallbackAnswerText = params.lastAssistant ? extractAssistantText(params.lastAssistant) : "";
  const rawAnswerTexts = params.assistantTexts.length
    ? params.assistantTexts
    : fallbackAnswerText
      ? [fallbackAnswerText]
      : [];
  const priorErroredAssistant =
    params.lastErroredAssistant?.stopReason === "error" ? params.lastErroredAssistant : undefined;
  if (!priorErroredAssistant) {
    return undefined;
  }
  const priorErrorState = resolveAssistantErrorState(priorErroredAssistant, params);
  const shouldSuppressRawErrorText = createRawErrorSuppressor(priorErrorState);
  const survivingAnswerTexts = rawAnswerTexts.filter((text) => !shouldSuppressRawErrorText(text));
  return survivingAnswerTexts.length === 0 ? priorErroredAssistant : undefined;
}

function resolveAssistantErrorState(
  assistant: AssistantMessage | undefined,
  params: {
    config?: OpenClawConfig;
    sessionKey: string;
    provider?: string;
    model?: string;
  },
): ResolvedAssistantErrorState {
  const rawErrorMessage =
    assistant?.stopReason === "error" ? assistant.errorMessage?.trim() || undefined : undefined;
  const errorText =
    assistant?.stopReason === "error"
      ? formatAssistantErrorText(assistant, {
          cfg: params.config,
          sessionKey: params.sessionKey,
          provider: params.provider,
          model: params.model,
        })
      : undefined;
  const formattedRawErrorMessage = rawErrorMessage
    ? formatRawAssistantErrorForUi(rawErrorMessage)
    : null;
  return {
    errorText,
    rawErrorMessage,
    rawErrorFingerprint: rawErrorMessage ? getApiErrorPayloadFingerprint(rawErrorMessage) : null,
    formattedRawErrorMessage,
    normalizedFormattedRawErrorMessage: formattedRawErrorMessage
      ? normalizeTextForComparison(formattedRawErrorMessage)
      : null,
    normalizedRawErrorText: rawErrorMessage ? normalizeTextForComparison(rawErrorMessage) : null,
    normalizedErrorText: errorText ? normalizeTextForComparison(errorText) : null,
  };
}

function createRawErrorSuppressor(errorState: ResolvedAssistantErrorState) {
  return (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (errorState.rawErrorMessage && trimmed === errorState.rawErrorMessage) {
      return true;
    }
    if (errorState.formattedRawErrorMessage && trimmed === errorState.formattedRawErrorMessage) {
      return true;
    }
    const normalized = normalizeTextForComparison(trimmed);
    if (
      normalized &&
      errorState.normalizedRawErrorText &&
      normalized === errorState.normalizedRawErrorText
    ) {
      return true;
    }
    if (
      normalized &&
      errorState.normalizedFormattedRawErrorMessage &&
      normalized === errorState.normalizedFormattedRawErrorMessage
    ) {
      return true;
    }
    if (errorState.rawErrorFingerprint) {
      const fingerprint = getApiErrorPayloadFingerprint(trimmed);
      if (fingerprint && fingerprint === errorState.rawErrorFingerprint) {
        return true;
      }
    }
    return isRawApiErrorPayload(trimmed);
  };
}
