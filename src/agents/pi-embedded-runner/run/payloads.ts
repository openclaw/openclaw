import type { AssistantMessage } from "@mariozechner/pi-ai";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../../../auto-reply/reply/reply-directives.js";
import type { ReasoningLevel, VerboseLevel } from "../../../auto-reply/thinking.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
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

const FAILURE_REASON_MAX_LENGTH = 120;

/**
 * Truncate a tool error reason to a short suffix suitable for the chat warning.
 * Takes the first non-empty line and caps at {@link FAILURE_REASON_MAX_LENGTH} chars.
 */
function truncateErrorReason(error: string): string {
  // Strip external-content security wrappers and SECURITY NOTICE banners
  // BEFORE selecting the first line, so web_fetch failures surface the actual
  // HTTP error instead of internal security markers (#46592).
  let stripped = error.replace(/<<<\s*(?:END_)?EXTERNAL_UNTRUSTED_CONTENT\b[^>]*>>>/g, "");
  stripped = stripped.replace(/SECURITY NOTICE:[\s\S]*?(?=\n\n|\n(?=[^\s-]))/g, "");
  // Skip web-fetch metadata lines prepended by wrapWebFetchContent() /
  // wrapExternalContent() (e.g. "Source: …", "From: …", "Subject: …", "---")
  // so the first-line extractor surfaces the actual error (#46592).
  const lines = stripped.split("\n").map((l) => l.trim());
  let startIdx = 0;
  while (startIdx < lines.length) {
    const line = lines[startIdx];
    if (line.length === 0 || /^(?:Source|From|Subject):\s/i.test(line) || line === "---") {
      startIdx++;
      continue;
    }
    break;
  }
  const firstLine = lines.slice(startIdx).find((l) => l.length > 0) ?? "";
  // Strip internal tool-context prefixes (e.g. "agent=… node=… gateway=… action=…: ")
  // to avoid leaking implementation details into user-facing warnings (#46592).
  let cleaned = firstLine.replace(/^(?:\w+=\S+\s+)*\w+=\S+:\s*/, "");
  // Scrub data: URIs which may embed raw file content (e.g. base64 PDFs)
  // and http(s) URLs which may contain signed tokens / credentials (#46592).
  // URL scrubbing runs BEFORE path scrubbing so URLs like
  // "https://s3.amazonaws.com/bucket/file.pdf" are not partially matched
  // by the filesystem-path regex.
  // The `i` flag ensures mixed/uppercase schemes (e.g. "HTTPS://", "Data:")
  // are redacted as well (#46592 review).
  cleaned = cleaned.replace(/data:[a-zA-Z0-9/+._-]*[;,]\S*/gi, "<data-uri>");
  cleaned = cleaned.replace(/(?:https?|wss?):\/\/\S+/gi, "<url>");
  // Scrub absolute filesystem paths — any Unix path with 2+ segments and
  // Windows drive-letter roots (C:\...) — to avoid leaking sandbox/host
  // directory structure in non-verbose mode (#46592).
  // Match path segments (no spaces) to preserve trailing reason text such as
  // "(unsafe path)" or ": permission denied".  Excludes /dev/null which
  // commonly appears in prose.
  // The Unicode-aware character classes (\p{L}\p{N}) ensure paths whose first
  // segment starts with a dot (/.ssh/…) or non-ASCII characters (/資料/…)
  // are also redacted (#46592 review).
  cleaned = cleaned.replace(
    /\/(?!dev\/null\b)(?:[a-zA-Z0-9_.]|[\p{L}\p{N}])(?:[a-zA-Z0-9._+-]|[\p{L}\p{N}])*(?:\/(?:[a-zA-Z0-9._+-]|[\p{L}\p{N}])+)+/gu,
    "<path>",
  );
  // Second pass (three sub-passes): absorb space-bearing remnants and Unicode
  // characters/apostrophes left after the strict ASCII-only first pass.
  // E.g. `/Users/O'Connor/…` becomes `<path>'Connor/…` after pass 1, and
  // `/home/user name/docs/f.txt` becomes `<path> name/docs/f.txt`.
  // Sub-passes are split so that trailing reason text like " not found" is
  // never swallowed (#46592).

  // 2a — directly-attached non-space remnants (Unicode chars, apostrophes)
  // with optional slash-separated path continuations.
  cleaned = cleaned.replace(/<path>['\p{L}\p{N}._+-]+(?:\/['\p{L}\p{N}._+-]+)*/gu, "<path>");
  // 2b — space-separated words only when followed by `/` or another `<path>`
  // (i.e. they are path-internal, not trailing reason text).
  cleaned = cleaned.replace(/<path>(?:\s+['\p{L}\p{N}._+-]+)+(?=\/|<path>)/gu, "<path>");
  // 2c — absorb remaining `/segment` runs directly after `<path>`.
  cleaned = cleaned.replace(/<path>(?:\/['\p{L}\p{N}._+-]+)+/gu, "<path>");
  // Collapse consecutive `<path>` markers left by multi-sub-pass rewrites.
  cleaned = cleaned.replace(/(?:<path>)+/g, "<path>");
  // Windows paths may contain spaces (e.g. "C:\Users\Jane Doe\...") and parens
  // ("C:\Program Files (x86)\...").  A trailing parenthetical reason like
  // " (unsafe path)" is restored so it isn't swallowed (#46592).
  cleaned = cleaned.replace(/[A-Za-z]:\\[\w\\. ()+-]+(?:\\[\w\\. ()+-]+)*/g, (match) => {
    // Don't swallow trailing parenthetical reasons like " (unsafe path)".
    // Path-internal parens such as "(x86)" are always followed by a backslash
    // segment, so they never appear at the very end of the matched text.
    const reasonMatch = match.match(/\s+\([a-zA-Z][a-zA-Z\s]*\)\s*$/);
    if (reasonMatch) {
      return "<path>" + reasonMatch[0];
    }
    return "<path>";
  });
  // UNC paths (\\server\share\...)
  cleaned = cleaned.replace(/\\\\[\w.-]+(?:\\[\w. ()+-]+)+/g, "<path>");
  // Scrub session keys that may embed channel-specific PII such as phone
  // numbers or chat IDs (e.g. "agent:main:whatsapp:direct:+15555550123").
  // P2 review thread on #46592.
  cleaned = cleaned.replace(
    /\b(?:agent|session):[a-zA-Z0-9_-]+(?::[a-zA-Z0-9_.+@-]+){2,}/g,
    "<session>",
  );
  // Collapse runs of whitespace left after scrubbing.
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  // Do NOT fall back to `firstLine` when `cleaned` is empty: a prefix-only
  // error (e.g. "agent=… node=… gateway=… action=invoke:") should produce an
  // empty reason rather than leaking raw internal identifiers into a
  // non-verbose chat warning (#46592 review thread PRRT_kwDOQb6kR853kLOL).
  const line = cleaned;
  if (line.length <= FAILURE_REASON_MAX_LENGTH) {
    return line;
  }
  return line.slice(0, FAILURE_REASON_MAX_LENGTH) + "…";
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
      const errorSuffix = (() => {
        if (!params.lastToolError.error) {
          return "";
        }
        if (warningPolicy.includeDetails) {
          return `: ${params.lastToolError.error}`;
        }
        // Only include the " — reason" suffix when scrubbing produces a
        // non-empty reason; prefix-only errors (e.g. "agent=… action=…:")
        // reduce to "" after scrubbing and should not produce a trailing
        // " — " in the warning text (#46592).
        const reason = truncateErrorReason(params.lastToolError.error);
        return reason ? ` — ${reason}` : "";
      })();
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
      if (p.text && isSilentReplyPayloadText(p.text, SILENT_REPLY_TOKEN)) {
        return false;
      }
      return true;
    });
}
