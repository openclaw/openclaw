import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
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

const TERMINAL_EMPTY_TOOL_RESULT_FALLBACK_MAX_CHARS = 1_600;
const TOOL_RESULT_SUMMARY_KEY_PRIORITY = [
  "metrics",
  "checkpoints",
  "experiments",
  "models",
  "files",
  "results",
] as const;
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

function extractFirstTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    const text = (block as { text?: unknown }).text;
    if (type === "text" && typeof text === "string" && text.trim()) {
      return text.trim();
    }
  }
  return undefined;
}

function isPrimitiveArray(value: unknown): value is Array<string | number | boolean> {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => ["string", "number", "boolean"].includes(typeof item))
  );
}

function formatStructuredToolResultSummary(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  const arrayKeys = Object.keys(record).filter((key) => isPrimitiveArray(record[key]));
  const prioritizedKey =
    TOOL_RESULT_SUMMARY_KEY_PRIORITY.find((key) => arrayKeys.includes(key)) ?? arrayKeys[0];
  if (prioritizedKey) {
    const values = record[prioritizedKey] as Array<string | number | boolean>;
    const joined = values.join(", ");
    if (joined.length > 0 && joined.length <= TERMINAL_EMPTY_TOOL_RESULT_FALLBACK_MAX_CHARS) {
      const label = prioritizedKey.charAt(0).toUpperCase() + prioritizedKey.slice(1);
      return `${label}: ${joined}`;
    }
  }

  const ok = typeof record.ok === "boolean" ? record.ok : undefined;
  const errors = Array.isArray(record.errors) ? record.errors.length : undefined;
  const warnings = Array.isArray(record.warnings) ? record.warnings.length : undefined;
  if (ok !== undefined || errors !== undefined || warnings !== undefined) {
    const parts = [
      ok !== undefined ? `ok=${ok}` : null,
      errors !== undefined ? `errors=${errors}` : null,
      warnings !== undefined ? `warnings=${warnings}` : null,
    ].filter(Boolean);
    if (parts.length > 0) {
      return parts.join(", ");
    }
  }
  return undefined;
}

function clipToolResultText(text: string): string {
  if (text.length <= TERMINAL_EMPTY_TOOL_RESULT_FALLBACK_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, TERMINAL_EMPTY_TOOL_RESULT_FALLBACK_MAX_CHARS).trimEnd()}

[Truncated]`;
}

function buildTerminalEmptyAssistantToolFallback(params: {
  lastAssistant?: AssistantMessage;
  messagesSnapshot?: AgentMessage[];
  suppressAssistantArtifacts: boolean;
  didSendViaMessagingTool?: boolean;
}): string | undefined {
  if (params.suppressAssistantArtifacts || params.didSendViaMessagingTool) {
    return undefined;
  }
  const lastAssistant = params.lastAssistant;
  if (!lastAssistant || lastAssistant.stopReason === "error" || lastAssistant.content.length > 0) {
    return undefined;
  }
  const messages = params.messagesSnapshot;
  if (!messages || messages.length < 2) {
    return undefined;
  }
  const lastMessage = messages[messages.length - 1];
  const previousMessage = messages[messages.length - 2];
  if (
    (lastMessage as { role?: unknown }).role !== "assistant" ||
    (previousMessage as { role?: unknown }).role !== "toolResult"
  ) {
    return undefined;
  }

  const toolNameRaw = (previousMessage as { toolName?: unknown }).toolName;
  const toolName =
    typeof toolNameRaw === "string" && toolNameRaw.trim().length > 0 ? toolNameRaw.trim() : "tool";
  const toolText = extractFirstTextContent((previousMessage as { content?: unknown }).content);
  if (!toolText) {
    return `Tool \`${toolName}\` completed, but the model returned no final text.`;
  }
  const summarized = formatStructuredToolResultSummary(toolText);
  if (summarized) {
    return `Tool \`${toolName}\` completed, but the model returned no final text.

${summarized}`;
  }
  return `Tool \`${toolName}\` completed, but the model returned no final text.

${clipToolResultText(toolText)}`;
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
  messagesSnapshot?: AgentMessage[];
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
}): Array<{
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  isReasoning?: boolean;
  audioAsVoice?: boolean;
  replyToTag?: boolean;
  replyToCurrent?: boolean;
}> {
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
  const lastAssistantErrored = params.lastAssistant?.stopReason === "error";
  const errorText =
    params.lastAssistant && lastAssistantErrored
      ? suppressAssistantArtifacts
        ? undefined
        : formatAssistantErrorText(params.lastAssistant, {
            cfg: params.config,
            sessionKey: params.sessionKey,
            provider: params.provider,
            model: params.model,
          })
      : undefined;
  const rawErrorMessage = lastAssistantErrored
    ? params.lastAssistant?.errorMessage?.trim() || undefined
    : undefined;
  const rawErrorFingerprint = rawErrorMessage
    ? getApiErrorPayloadFingerprint(rawErrorMessage)
    : null;
  const formattedRawErrorMessage = rawErrorMessage
    ? formatRawAssistantErrorForUi(rawErrorMessage)
    : null;
  const normalizedFormattedRawErrorMessage = formattedRawErrorMessage
    ? normalizeTextForComparison(formattedRawErrorMessage)
    : null;
  const normalizedRawErrorText = rawErrorMessage
    ? normalizeTextForComparison(rawErrorMessage)
    : null;
  const normalizedErrorText = errorText ? normalizeTextForComparison(errorText) : null;
  const normalizedGenericBillingErrorText = normalizeTextForComparison(BILLING_ERROR_USER_MESSAGE);
  const genericErrorText = "The AI service returned an error. Please try again.";
  if (errorText) {
    replyItems.push({ text: errorText, isError: true });
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

  const fallbackAnswerText = params.lastAssistant ? extractAssistantText(params.lastAssistant) : "";
  const shouldSuppressRawErrorText = (text: string) => {
    if (!lastAssistantErrored) {
      return false;
    }
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }
    if (errorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalizedErrorText && normalized === normalizedErrorText) {
        return true;
      }
      if (trimmed === genericErrorText) {
        return true;
      }
      if (
        normalized &&
        normalizedGenericBillingErrorText &&
        normalized === normalizedGenericBillingErrorText
      ) {
        return true;
      }
    }
    if (rawErrorMessage && trimmed === rawErrorMessage) {
      return true;
    }
    if (formattedRawErrorMessage && trimmed === formattedRawErrorMessage) {
      return true;
    }
    if (normalizedRawErrorText) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedRawErrorText) {
        return true;
      }
    }
    if (normalizedFormattedRawErrorMessage) {
      const normalized = normalizeTextForComparison(trimmed);
      if (normalized && normalized === normalizedFormattedRawErrorMessage) {
        return true;
      }
    }
    if (rawErrorFingerprint) {
      const fingerprint = getApiErrorPayloadFingerprint(trimmed);
      if (fingerprint && fingerprint === rawErrorFingerprint) {
        return true;
      }
    }
    return isRawApiErrorPayload(trimmed);
  };
  const answerTexts = suppressAssistantArtifacts
    ? []
    : (params.assistantTexts.length
        ? params.assistantTexts
        : fallbackAnswerText
          ? [fallbackAnswerText]
          : []
      ).filter((text) => !shouldSuppressRawErrorText(text));
  if (answerTexts.length === 0) {
    const terminalEmptyFallback = buildTerminalEmptyAssistantToolFallback({
      lastAssistant: params.lastAssistant,
      messagesSnapshot: params.messagesSnapshot,
      suppressAssistantArtifacts,
      didSendViaMessagingTool: params.didSendViaMessagingTool,
    });
    if (terminalEmptyFallback) {
      answerTexts.push(terminalEmptyFallback);
    }
  }

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
      if (!hasOutboundReplyContent(p)) {
        return false;
      }
      if (p.text && isSilentReplyText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}
