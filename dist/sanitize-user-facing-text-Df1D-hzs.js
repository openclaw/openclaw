import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as stableStringify } from "./stable-stringify-TfJ9A6yH.js";
import { u as stripInternalRuntimeContext } from "./internal-runtime-context-DWxvZFcB.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-D2-__BeH.js";
import { a as isGenericProviderInternalError, i as isCloudflareOrHtmlErrorPage, n as extractLeadingHttpStatus, o as parseApiErrorInfo, r as formatRawAssistantErrorForUi, s as parseApiErrorPayload } from "./assistant-error-format-CuUvHfKt.js";
import { t as coerceChatContentText } from "./chat-content-BNTcXm1Z.js";
import { c as stripToolCallXmlTags, f as stripFinalTags, o as stripLegacyBracketToolCallBlocks, s as stripMinimaxToolCallXml } from "./assistant-visible-text-BoF6Ixue.js";
import { c as isTimeoutErrorMessage, i as isOverloadedErrorMessage, o as isRateLimitErrorMessage, r as isBillingErrorMessage } from "./failover-matches-C-tab7FS.js";
//#region src/agents/exec-approval-result.ts
const EXEC_COMPLETED_RE = /^exec completed:\s*([\s\S]*)$/i;
const APPROVAL_METADATA_SOURCE_RE = /^(?:gateway\s+id=|node=)/i;
function parseExecApprovalResultWithMetadata(raw, prefix, bodySeparator) {
	const normalizedRaw = normalizeLowercaseStringOrEmpty(raw);
	const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
	if (!normalizedRaw.startsWith(normalizedPrefix)) return null;
	const metadataStart = prefix.length;
	let depth = 1;
	let metadataEnd = -1;
	for (let index = metadataStart; index < raw.length; index += 1) {
		const char = raw[index];
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				metadataEnd = index;
				break;
			}
		}
	}
	if (metadataEnd < 0) return null;
	const metadata = raw.slice(metadataStart, metadataEnd).trim();
	if (!APPROVAL_METADATA_SOURCE_RE.test(metadata)) return null;
	const remainder = raw.slice(metadataEnd + 1);
	if (bodySeparator === ":") {
		if (!remainder.startsWith(":")) return null;
		return {
			metadata,
			body: remainder.slice(1).trim()
		};
	}
	if (remainder && !remainder.startsWith("\n")) return null;
	return {
		metadata,
		body: remainder.startsWith("\n") ? remainder.slice(1).trim() : ""
	};
}
function parseExecApprovalResultText(resultText) {
	const raw = resultText.trim();
	if (!raw) return {
		kind: "other",
		raw
	};
	const deniedResult = parseExecApprovalResultWithMetadata(raw, "Exec denied (", ":");
	if (deniedResult) return {
		kind: "denied",
		raw,
		metadata: deniedResult.metadata,
		body: deniedResult.body
	};
	const finishedResult = parseExecApprovalResultWithMetadata(raw, "Exec finished (", "\n");
	if (finishedResult) return {
		kind: "finished",
		raw,
		metadata: finishedResult.metadata,
		body: finishedResult.body
	};
	const completedMatch = EXEC_COMPLETED_RE.exec(raw);
	if (completedMatch) return {
		kind: "completed",
		raw,
		body: completedMatch[1]?.trim() ?? ""
	};
	return {
		kind: "other",
		raw
	};
}
function isExecDeniedResultText(resultText) {
	return parseExecApprovalResultText(resultText).kind === "denied";
}
function formatExecDeniedUserMessage(resultText) {
	const parsed = parseExecApprovalResultText(resultText);
	if (parsed.kind !== "denied") return null;
	const metadata = normalizeLowercaseStringOrEmpty(parsed.metadata);
	if (metadata.includes("approval-timeout")) return "Command did not run: approval timed out.";
	if (metadata.includes("user-denied")) return "Command did not run: approval was denied.";
	if (metadata.includes("allowlist-miss")) return "Command did not run: approval is required.";
	if (metadata.includes("approval-request-failed")) return "Command did not run: approval request failed.";
	if (metadata.includes("spawn-failed") || metadata.includes("invoke-failed")) return "Command did not run.";
	return "Command did not run.";
}
//#endregion
//#region src/agents/pi-embedded-helpers/sanitize-user-facing-text.ts
function formatBillingErrorMessage(provider, model) {
	const providerName = provider?.trim();
	const modelName = model?.trim();
	const providerLabel = providerName && modelName ? `${providerName} (${modelName})` : providerName || void 0;
	if (providerLabel) return `⚠️ ${providerLabel} returned a billing error — your API key has run out of credits or has an insufficient balance. Check your ${providerName} billing dashboard and top up or switch to a different API key.`;
	return "⚠️ API provider returned a billing error — your API key has run out of credits or has an insufficient balance. Check your provider's billing dashboard and top up or switch to a different API key.";
}
const BILLING_ERROR_USER_MESSAGE = formatBillingErrorMessage();
const RATE_LIMIT_ERROR_USER_MESSAGE = "⚠️ API rate limit reached. Please try again later.";
const MODEL_CAPACITY_ERROR_USER_MESSAGE = "⚠️ Selected model is at capacity. Try a different model, or wait and retry.";
const OVERLOADED_ERROR_USER_MESSAGE = "The AI service is temporarily overloaded. Please try again in a moment.";
const TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE = /^[ \t]*\[tool calls omitted\][ \t]*$/i;
const ERROR_PREFIX_RE = /^(?:error|(?:[a-z][\w-]*\s+)?api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|codex\s*error|request failed|failed|exception)(?:\s+\d{3})?[:\s-]+/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE = /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context length exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const HTTP_ERROR_HINTS = [
	"error",
	"bad request",
	"not found",
	"unauthorized",
	"forbidden",
	"internal server",
	"service unavailable",
	"gateway",
	"rate limit",
	"overloaded",
	"timeout",
	"timed out",
	"invalid",
	"too many requests",
	"permission"
];
const RATE_LIMIT_SPECIFIC_HINT_RE = /\bmin(ute)?s?\b|\bhours?\b|\bseconds?\b|\btry again in\b|\breset\b|\bplan\b|\bquota\b/i;
const MODEL_CAPACITY_ERROR_RE = /\b(?:selected\s+)?model\s+(?:is\s+)?at capacity\b/i;
const NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH = 16384;
const NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE = /^codex\s*error(?:\s+\d{3})?[:\s-]+/i;
function extractProviderRateLimitMessage(raw) {
	const withoutPrefix = raw.replace(ERROR_PREFIX_RE, "").trim();
	const candidate = (parseApiErrorInfo(raw) ?? parseApiErrorInfo(withoutPrefix))?.message ?? (extractLeadingHttpStatus(withoutPrefix)?.rest || withoutPrefix);
	if (!candidate || !RATE_LIMIT_SPECIFIC_HINT_RE.test(candidate)) return;
	if (isCloudflareOrHtmlErrorPage(withoutPrefix)) return;
	const trimmed = candidate.trim();
	if (trimmed.length > 300 || trimmed.startsWith("{") || /^(?:<!doctype\s+html\b|<html\b)/i.test(trimmed)) return;
	return `⚠️ ${trimmed}`;
}
function formatRateLimitOrOverloadedErrorCopy(raw) {
	if (isRateLimitErrorMessage(raw)) return extractProviderRateLimitMessage(raw) ?? RATE_LIMIT_ERROR_USER_MESSAGE;
	if (MODEL_CAPACITY_ERROR_RE.test(raw)) return MODEL_CAPACITY_ERROR_USER_MESSAGE;
	if (isOverloadedErrorMessage(raw)) return OVERLOADED_ERROR_USER_MESSAGE;
}
function formatTransportErrorCopy(raw) {
	if (!raw) return;
	if (isCloudflareOrHtmlErrorPage(raw)) return;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	if (/\beconnrefused\b/i.test(raw) || lower.includes("connection refused") || lower.includes("actively refused")) return "LLM request failed: connection refused by the provider endpoint.";
	if (/\beconnreset\b|\beconnaborted\b|\benetreset\b|\bepipe\b/i.test(raw) || lower.includes("socket hang up") || lower.includes("connection reset") || lower.includes("connection aborted")) return "LLM request failed: network connection was interrupted.";
	if (/\benotfound\b|\beai_again\b/i.test(raw) || lower.includes("getaddrinfo") || lower.includes("no such host") || lower.includes("dns")) return "LLM request failed: DNS lookup for the provider endpoint failed.";
	if (/\benetunreach\b|\behostunreach\b|\behostdown\b/i.test(raw) || lower.includes("network is unreachable") || lower.includes("host is unreachable")) return "LLM request failed: the provider endpoint is unreachable from this host.";
	if (lower.includes("fetch failed") || lower.includes("connection error") || lower.includes("network request failed")) return "LLM request failed: network connection error.";
	if (raw.includes("网络错误") || raw.includes("网络异常") || raw.includes("连接错误")) return "LLM request failed: provider reported a network error.";
}
function formatDiskSpaceErrorCopy(raw) {
	if (!raw) return;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	if (/\benospc\b/i.test(raw) || lower.includes("no space left on device") || lower.includes("disk full")) return "OpenClaw could not write local session data because the disk is full. Free some disk space and try again.";
}
function isReasoningConstraintErrorMessage(raw) {
	if (!raw) return false;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	return lower.includes("reasoning is mandatory") || lower.includes("reasoning is required") || lower.includes("requires reasoning") || lower.includes("reasoning") && lower.includes("cannot be disabled");
}
function isInvalidStreamingEventOrderError(raw) {
	if (!raw) return false;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	return lower.includes("unexpected event order") && lower.includes("message_start") && lower.includes("message_stop");
}
function isStreamingJsonParseError(raw) {
	if (!raw) return false;
	if (raw.trim() === "OpenClaw transport error: malformed_streaming_fragment") return true;
	return false;
}
function hasRateLimitTpmHint(raw) {
	const lower = normalizeLowercaseStringOrEmpty(raw);
	return /\btpm\b/i.test(lower) || lower.includes("tokens per minute");
}
function looksLikeGenericContextOverflowError(raw) {
	if (!raw) return false;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	const hasRequestSizeExceeds = lower.includes("request size exceeds");
	const hasContextWindow = lower.includes("context window") || lower.includes("context length") || lower.includes("maximum context length");
	return lower.includes("request_too_large") || lower.includes("invalid_argument") && lower.includes("maximum number of tokens") || lower.includes("request exceeds the maximum size") || lower.includes("context length exceeded") || lower.includes("maximum context length") || lower.includes("prompt is too long") || lower.includes("prompt too long") || lower.includes("exceeds model context window") || lower.includes("model token limit") || lower.includes("input exceeds") && lower.includes("maximum number of tokens") || hasRequestSizeExceeds && hasContextWindow || lower.includes("context overflow:") || lower.includes("exceed context limit") || lower.includes("exceeds the model's maximum context") || lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context") || lower.includes("input length") && lower.includes("exceed") && lower.includes("context") || lower.includes("413") && lower.includes("too large") || lower.includes("context_window_exceeded") || raw.includes("上下文过长") || raw.includes("上下文超出") || raw.includes("上下文长度超") || raw.includes("超出最大上下文") || raw.includes("请压缩上下文");
}
function shouldRewriteContextOverflowText(raw) {
	if (hasRateLimitTpmHint(raw) || isReasoningConstraintErrorMessage(raw)) return false;
	if (!looksLikeGenericContextOverflowError(raw)) return false;
	return isRawApiErrorPayload(raw) || isLikelyHttpErrorText(raw) || ERROR_PREFIX_RE.test(raw) || CONTEXT_OVERFLOW_ERROR_HEAD_RE.test(raw);
}
function getApiErrorPayloadFingerprint(raw) {
	if (!raw) return null;
	const payload = parseApiErrorPayload(raw);
	if (!payload) return null;
	return stableStringify(payload);
}
function isRawApiErrorPayload(raw) {
	return getApiErrorPayloadFingerprint(raw) !== null;
}
function isLikelyProviderErrorType(type) {
	const normalized = normalizeOptionalLowercaseString(type);
	if (!normalized) return false;
	return normalized.endsWith("_error");
}
function shouldRewriteRawPayloadWithoutErrorContext(raw) {
	if (raw.length > NON_ERROR_PROVIDER_PAYLOAD_MAX_LENGTH) return false;
	if (!NON_ERROR_PROVIDER_PAYLOAD_PREFIX_RE.test(raw)) return false;
	const info = parseApiErrorInfo(raw);
	if (!info) return false;
	if (isLikelyProviderErrorType(info.type)) return true;
	if (info.httpCode) {
		const parsedCode = Number(info.httpCode);
		if (Number.isFinite(parsedCode) && parsedCode >= 400) return true;
	}
	return false;
}
function stripFinalTagsFromText(text) {
	const normalized = coerceChatContentText(text);
	if (!normalized) return normalized;
	return stripFinalTags(normalized);
}
function stripToolCallsOmittedPlaceholderLines(text) {
	let result = "";
	let start = 0;
	while (start < text.length) {
		const newlineIndex = text.indexOf("\n", start);
		const end = newlineIndex === -1 ? text.length : newlineIndex + 1;
		const chunk = text.slice(start, end);
		const line = chunk.endsWith("\n") ? chunk.slice(0, -1).replace(/\r$/, "") : chunk;
		if (!TOOL_CALLS_OMITTED_PLACEHOLDER_LINE_RE.test(line)) result += chunk;
		start = end;
	}
	return result;
}
function collapseConsecutiveDuplicateBlocks(text) {
	const trimmed = text.trim();
	if (!trimmed) return text;
	const blocks = trimmed.split(/\n{2,}/);
	if (blocks.length < 2) return text;
	const normalizeBlock = (value) => value.trim().replace(/\s+/g, " ");
	const result = [];
	let lastNormalized = null;
	for (const block of blocks) {
		const normalized = normalizeBlock(block);
		if (lastNormalized && normalized === lastNormalized) continue;
		result.push(block.trim());
		lastNormalized = normalized;
	}
	if (result.length === blocks.length) return text;
	return result.join("\n\n");
}
function isLikelyHttpErrorText(raw) {
	if (isCloudflareOrHtmlErrorPage(raw)) return true;
	const status = extractLeadingHttpStatus(raw);
	if (!status) return false;
	if (status.code < 400) return false;
	const message = normalizeLowercaseStringOrEmpty(status.rest);
	return HTTP_ERROR_HINTS.some((hint) => message.includes(hint));
}
function sanitizeUserFacingText(text, opts) {
	const raw = coerceChatContentText(text);
	if (!raw) return raw;
	const errorContext = opts?.errorContext ?? false;
	const withoutToolCallBlocks = stripLegacyBracketToolCallBlocks(stripToolCallsOmittedPlaceholderLines(stripToolCallXmlTags(stripMinimaxToolCallXml(stripInboundMetadata(stripInternalRuntimeContext(stripFinalTagsFromText(raw)))), { stripFunctionCallsXmlPayloads: true })));
	const trimmed = withoutToolCallBlocks.trim();
	if (!trimmed) return "";
	if (!errorContext && shouldRewriteRawPayloadWithoutErrorContext(trimmed)) return formatRawAssistantErrorForUi(trimmed);
	if (errorContext) {
		const execDeniedMessage = formatExecDeniedUserMessage(trimmed);
		if (execDeniedMessage) return execDeniedMessage;
		const diskSpaceCopy = formatDiskSpaceErrorCopy(trimmed);
		if (diskSpaceCopy) return diskSpaceCopy;
		if (/incorrect role information|roles must alternate/i.test(trimmed)) return "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
		if (shouldRewriteContextOverflowText(trimmed)) return "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
		if (isBillingErrorMessage(trimmed)) return BILLING_ERROR_USER_MESSAGE;
		if (isGenericProviderInternalError(trimmed)) return formatRawAssistantErrorForUi(trimmed);
		if (isInvalidStreamingEventOrderError(trimmed)) return "LLM request failed: provider returned an invalid streaming response. Please try again.";
		if (isRawApiErrorPayload(trimmed) || isLikelyHttpErrorText(trimmed)) return formatRawAssistantErrorForUi(trimmed);
		if (isStreamingJsonParseError(trimmed)) return "LLM streaming response contained a malformed fragment. Please try again.";
		if (ERROR_PREFIX_RE.test(trimmed)) {
			const prefixedCopy = formatRateLimitOrOverloadedErrorCopy(trimmed);
			if (prefixedCopy) return prefixedCopy;
			const transportCopy = formatTransportErrorCopy(trimmed);
			if (transportCopy) return transportCopy;
			if (isTimeoutErrorMessage(trimmed)) return "LLM request timed out.";
			return formatRawAssistantErrorForUi(trimmed);
		}
	}
	return collapseConsecutiveDuplicateBlocks(withoutToolCallBlocks.replace(/^(?:[ \t]*\r?\n)+/, ""));
}
//#endregion
export { formatTransportErrorCopy as a, isLikelyHttpErrorText as c, sanitizeUserFacingText as d, formatExecDeniedUserMessage as f, formatRateLimitOrOverloadedErrorCopy as i, isRawApiErrorPayload as l, parseExecApprovalResultText as m, formatBillingErrorMessage as n, getApiErrorPayloadFingerprint as o, isExecDeniedResultText as p, formatDiskSpaceErrorCopy as r, isInvalidStreamingEventOrderError as s, BILLING_ERROR_USER_MESSAGE as t, isStreamingJsonParseError as u };
