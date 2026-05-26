import { a as normalizeLowercaseStringOrEmpty, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as isGenericProviderInternalError, n as extractLeadingHttpStatus, r as formatRawAssistantErrorForUi } from "./assistant-error-format-CuUvHfKt.js";
import { a as formatTransportErrorCopy, c as isLikelyHttpErrorText, f as formatExecDeniedUserMessage, i as formatRateLimitOrOverloadedErrorCopy, l as isRawApiErrorPayload, n as formatBillingErrorMessage, r as formatDiskSpaceErrorCopy, s as isInvalidStreamingEventOrderError, u as isStreamingJsonParseError } from "./sanitize-user-facing-text-Df1D-hzs.js";
import { a as isPeriodicUsageLimitErrorMessage, c as isTimeoutErrorMessage, i as isOverloadedErrorMessage, l as matchesFormatErrorPattern, n as isAuthPermanentErrorMessage, o as isRateLimitErrorMessage, r as isBillingErrorMessage, s as isServerErrorMessage, t as isAuthErrorMessage } from "./failover-matches-C-tab7FS.js";
import { t as formatSandboxToolPolicyBlockedMessage } from "./runtime-status-BtoDvmSR.js";
import { n as classifyOAuthRefreshFailure } from "./oauth-refresh-failure-szcD_aib.js";
import { t as isModelNotFoundErrorMessage } from "./live-model-errors-BmBrfiMl.js";
//#region src/logging/node-require.ts
function resolveNodeRequireFromMeta(metaUrl) {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return null;
	try {
		const moduleNamespace = getBuiltinModule("module");
		const createRequire = typeof moduleNamespace.createRequire === "function" ? moduleNamespace.createRequire : null;
		return createRequire ? createRequire(metaUrl) : null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/agents/pi-embedded-helpers/provider-error-patterns.ts
/**
* Provider-owned error-pattern dispatch plus legacy fallback patterns.
*
* Most provider-specific failover classification now lives on provider-plugin
* hooks. This module keeps only fallback patterns for providers that do not
* yet ship a dedicated provider plugin hook surface.
*/
/**
* Provider-specific context overflow patterns not covered by the generic
* `isContextOverflowError()` in errors.ts. Called from `isContextOverflowError()`
* to catch provider-specific wording that the generic regex misses.
*/
const PROVIDER_CONTEXT_OVERFLOW_PATTERNS = [
	/\binput token count exceeds the maximum number of input tokens\b/i,
	/\binput is too long for this model\b/i,
	/\binput exceeds the maximum number of tokens\b/i,
	/\bollama error:\s*context length exceeded(?:,\s*too many tokens)?\b/i,
	/\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i,
	/\b(?:request|prompt) \(\d[\d,]*\s*tokens?\) exceeds (?:the )?available context size\b/i,
	/\binput (?:is )?too long for (?:the )?model\b/i
];
/**
* Provider-specific patterns that map to specific failover reasons.
* These handle cases where the generic classifiers in failover-matches.ts
* produce wrong results for specific providers.
*/
const PROVIDER_SPECIFIC_PATTERNS = [
	{
		test: /\bthrottlingexception\b/i,
		reason: "rate_limit"
	},
	{
		test: /\bconcurrency limit(?: has been)? reached\b/i,
		reason: "rate_limit"
	},
	{
		test: /\bworkers_ai\b.*\bquota limit exceeded\b/i,
		reason: "rate_limit"
	},
	{
		test: /\bmodelnotreadyexception\b/i,
		reason: "overloaded"
	},
	{
		test: /model(?:_is)?_deactivated|model has been deactivated/i,
		reason: "model_not_found"
	}
];
const requireProviderRuntime = resolveNodeRequireFromMeta(import.meta.url);
let cachedProviderRuntimeHooks;
const PROVIDER_CONTEXT_OVERFLOW_SIGNAL_RE = /\b(?:context|window|prompt|token|tokens|input|request|model)\b/i;
const PROVIDER_CONTEXT_OVERFLOW_ACTION_RE = /\b(?:too\s+(?:large|long|many)|exceed(?:s|ed|ing)?|overflow|limit|maximum|max)\b/i;
function resolveProviderRuntimeHooks() {
	if (cachedProviderRuntimeHooks !== void 0) return cachedProviderRuntimeHooks;
	if (!requireProviderRuntime) {
		cachedProviderRuntimeHooks = null;
		return cachedProviderRuntimeHooks;
	}
	try {
		const loaded = requireProviderRuntime("../../plugins/provider-runtime.js");
		cachedProviderRuntimeHooks = {
			classifyProviderFailoverReasonWithPlugin: ({ context }) => loaded.classifyProviderFailoverReasonWithPlugin({ context }) ?? null,
			matchesProviderContextOverflowWithPlugin: loaded.matchesProviderContextOverflowWithPlugin
		};
	} catch {
		cachedProviderRuntimeHooks = null;
	}
	return cachedProviderRuntimeHooks ?? null;
}
function looksLikeProviderContextOverflowCandidate(errorMessage) {
	return PROVIDER_CONTEXT_OVERFLOW_SIGNAL_RE.test(errorMessage) && PROVIDER_CONTEXT_OVERFLOW_ACTION_RE.test(errorMessage);
}
/**
* Check if an error message matches any provider-specific context overflow pattern.
* Called from `isContextOverflowError()` to catch provider-specific wording.
*/
function matchesProviderContextOverflow(errorMessage) {
	if (!looksLikeProviderContextOverflowCandidate(errorMessage)) return false;
	return resolveProviderRuntimeHooks()?.matchesProviderContextOverflowWithPlugin({ context: { errorMessage } }) === true || PROVIDER_CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(errorMessage));
}
/**
* Try to classify an error using provider-specific patterns.
* Returns null if no provider-specific pattern matches (fall through to generic classification).
*/
function classifyProviderSpecificError(errorMessage) {
	const pluginReason = resolveProviderRuntimeHooks()?.classifyProviderFailoverReasonWithPlugin({ context: { errorMessage } }) ?? null;
	if (pluginReason) return pluginReason;
	for (const pattern of PROVIDER_SPECIFIC_PATTERNS) if (pattern.test.test(errorMessage)) return pattern.reason;
	return null;
}
//#endregion
//#region src/agents/pi-embedded-helpers/errors.ts
const log = createSubsystemLogger("errors");
function isReasoningConstraintErrorMessage(raw) {
	if (!raw) return false;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	return lower.includes("reasoning is mandatory") || lower.includes("reasoning is required") || lower.includes("requires reasoning") || lower.includes("reasoning") && lower.includes("cannot be disabled");
}
function hasRateLimitTpmHint(raw) {
	const lower = normalizeLowercaseStringOrEmpty(raw);
	return /\btpm\b/i.test(lower) || lower.includes("tokens per minute");
}
function isContextOverflowError(errorMessage) {
	if (!errorMessage) return false;
	const lower = normalizeLowercaseStringOrEmpty(errorMessage);
	if (hasRateLimitTpmHint(errorMessage)) return false;
	if (isReasoningConstraintErrorMessage(errorMessage)) return false;
	const hasRequestSizeExceeds = lower.includes("request size exceeds");
	const hasContextWindow = lower.includes("context window") || lower.includes("context length") || lower.includes("maximum context length");
	return lower.includes("request_too_large") || lower.includes("invalid_argument") && lower.includes("maximum number of tokens") || lower.includes("request exceeds the maximum size") || lower.includes("context length exceeded") || lower.includes("maximum context length") || lower.includes("prompt is too long") || lower.includes("prompt too long") || lower.includes("exceeds model context window") || lower.includes("model token limit") || lower.includes("input exceeds") && lower.includes("maximum number of tokens") || hasRequestSizeExceeds && hasContextWindow || lower.includes("context overflow:") || lower.includes("exceed context limit") || lower.includes("exceeds the model's maximum context") || lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context") || lower.includes("input length") && lower.includes("exceed") && lower.includes("context") || lower.includes("413") && lower.includes("too large") || lower.includes("context_window_exceeded") || errorMessage.includes("上下文过长") || errorMessage.includes("上下文超出") || errorMessage.includes("上下文长度超") || errorMessage.includes("超出最大上下文") || errorMessage.includes("请压缩上下文") || matchesProviderContextOverflow(errorMessage);
}
const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;
const CONTEXT_OVERFLOW_HINT_RE = /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;
const RATE_LIMIT_HINT_RE = /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i;
function isLikelyContextOverflowError(errorMessage) {
	if (!errorMessage) return false;
	if (hasRateLimitTpmHint(errorMessage)) return false;
	if (isReasoningConstraintErrorMessage(errorMessage)) return false;
	if (isBillingErrorMessage(errorMessage)) return false;
	if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) return false;
	if (isRateLimitErrorMessage(errorMessage)) return false;
	if (isContextOverflowError(errorMessage)) return true;
	if (RATE_LIMIT_HINT_RE.test(errorMessage)) return false;
	return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}
function isCompactionFailureError(errorMessage) {
	if (!errorMessage) return false;
	const lower = normalizeLowercaseStringOrEmpty(errorMessage);
	if (!(lower.includes("summarization failed") || lower.includes("auto-compaction") || lower.includes("compaction failed") || lower.includes("compaction"))) return false;
	if (isLikelyContextOverflowError(errorMessage)) return true;
	return lower.includes("context overflow");
}
const OBSERVED_OVERFLOW_TOKEN_PATTERNS = [
	/prompt is too long:\s*([\d,]+)\s+tokens\s*>\s*[\d,]+\s+maximum/i,
	/requested\s+([\d,]+)\s+tokens/i,
	/resulted in\s+([\d,]+)\s+tokens/i
];
function extractObservedOverflowTokenCount(errorMessage) {
	if (!errorMessage) return;
	for (const pattern of OBSERVED_OVERFLOW_TOKEN_PATTERNS) {
		const rawCount = errorMessage.match(pattern)?.[1]?.replaceAll(",", "");
		if (!rawCount) continue;
		const parsed = Number(rawCount);
		if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
	}
}
const TRANSIENT_HTTP_ERROR_CODES = new Set([
	499,
	500,
	502,
	503,
	504,
	521,
	522,
	523,
	524,
	529
]);
const BILLING_402_HINTS = [
	"insufficient credits",
	"insufficient quota",
	"credit balance",
	"insufficient balance",
	"plans & billing",
	"add more credits",
	"top up"
];
const BILLING_402_PLAN_HINTS = [
	"upgrade your plan",
	"upgrade plan",
	"current plan",
	"subscription"
];
const PERIODIC_402_HINTS = [
	"daily",
	"weekly",
	"monthly"
];
const RETRYABLE_402_RETRY_HINTS = [
	"try again",
	"retry",
	"temporary",
	"cooldown"
];
const RETRYABLE_402_LIMIT_HINTS = [
	"usage limit",
	"rate limit",
	"organization usage"
];
const RETRYABLE_402_SCOPED_HINTS = ["organization", "workspace"];
const RETRYABLE_402_SCOPED_RESULT_HINTS = [
	"billing period",
	"exceeded",
	"reached",
	"exhausted"
];
const RAW_402_MARKER_RE = /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+(?:payment required\b|.*used up your points\b|no available asset for api access\b)/i;
const BARE_LEADING_402_RE = /^\s*402\b/i;
const LEADING_402_WRAPPER_RE = /^(?:error[:\s-]+)?(?:(?:http\s*)?402(?:\s+payment required)?|payment required)(?:[:\s-]+|$)/i;
const TIMEOUT_ERROR_CODES = new Set([
	"ETIMEDOUT",
	"ESOCKETTIMEDOUT",
	"ECONNRESET",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EHOSTDOWN",
	"ENETRESET",
	"EPIPE",
	"EAI_AGAIN"
]);
const AUTH_SCOPE_HINT_RE = /\b(?:missing|required|requires|insufficient)\s+(?:the\s+following\s+)?scopes?\b|\bmissing\s+scope\b/i;
const AUTH_SCOPE_NAME_RE = /\b(?:api\.responses\.write|model\.request)\b/i;
const HTML_BODY_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const HTML_CLOSE_RE = /<\/html>/i;
const PROXY_ERROR_RE = /\bproxyconnect\b|\bhttps?_proxy\b|\b407\b|\bproxy authentication required\b|\btunnel connection failed\b|\bconnect tunnel\b|\bsocks proxy\b|\bproxy error\b/i;
const DNS_ERROR_RE = /\benotfound\b|\beai_again\b|\bgetaddrinfo\b|\bno such host\b|\bdns\b/i;
const INTERRUPTED_NETWORK_ERROR_RE = /\beconnrefused\b|\beconnreset\b|\beconnaborted\b|\benetreset\b|\behostunreach\b|\behostdown\b|\benetunreach\b|\bepipe\b|\bsocket hang up\b|\bconnection refused\b|\bconnection reset\b|\bconnection aborted\b|\bnetwork is unreachable\b|\bhost is unreachable\b|\bfetch failed\b|\bconnection error\b|\bnetwork request failed\b/i;
const REPLAY_INVALID_RE = /\bprevious_response_id\b.*\b(?:invalid|unknown|not found|does not exist|expired|mismatch)\b|\btool_(?:use|call)\.(?:input|arguments)\b.*\b(?:missing|required)\b|\bincorrect role information\b|\broles must alternate\b|\binput item id does not belong to this connection\b/i;
const SANDBOX_BLOCKED_RE = /\bapproval is required\b|\bapproval timed out\b|\bapproval was denied\b|\bblocked by sandbox\b|\bsandbox\b.*\b(?:blocked|denied|forbidden|disabled|not allowed)\b|\bexec denied\s*\(/i;
const NO_BODY_HTTP_WRAPPER_RE = /^(?:no body(?: response)?|no response body|status code \(no body\))$/i;
function stripErrorPrefix(raw) {
	return raw.replace(/^error:\s*/i, "").trim();
}
function inferSignalStatus(signal) {
	if (typeof signal.status === "number" && Number.isFinite(signal.status)) return signal.status;
	return extractLeadingHttpStatus(stripErrorPrefix(signal.message?.trim() ?? ""))?.code;
}
function isExplicitNoBodyHttpMessage(raw, status) {
	const trimmed = raw?.trim();
	if (!trimmed) return false;
	const candidate = extractLeadingHttpStatus(trimmed) ? trimmed : stripErrorPrefix(trimmed);
	const leadingStatus = extractLeadingHttpStatus(candidate);
	if (leadingStatus) {
		if (typeof status === "number" && leadingStatus.code !== status) return false;
		return NO_BODY_HTTP_WRAPPER_RE.test(leadingStatus.rest);
	}
	return NO_BODY_HTTP_WRAPPER_RE.test(candidate);
}
function isUnclassifiedNoBodyHttpSignal(signal) {
	const status = inferSignalStatus(signal);
	if (status !== 400 && status !== 422) return false;
	const message = signal.message?.trim();
	return !message || isExplicitNoBodyHttpMessage(message, status);
}
function isHtmlErrorResponse(raw, status) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	const candidate = extractLeadingHttpStatus(trimmed) ? trimmed : stripErrorPrefix(trimmed);
	const inferred = typeof status === "number" && Number.isFinite(status) ? status : extractLeadingHttpStatus(candidate)?.code;
	if (typeof inferred !== "number" || inferred < 400) return false;
	const rest = extractLeadingHttpStatus(candidate)?.rest ?? candidate;
	return HTML_BODY_RE.test(rest) && HTML_CLOSE_RE.test(rest);
}
function isTransportHtmlErrorStatus(status) {
	return status === 408 || status === 499 || typeof status === "number" && status >= 500 && status < 600;
}
function isOpenAICodexScopeContext(raw, provider) {
	return normalizeLowercaseStringOrEmpty(provider) === "openai-codex" || /\bopenai\s+codex\b/i.test(raw) || /\bcodex\b.*\bscopes?\b/i.test(raw);
}
function isAuthScopeErrorMessage(raw, status, provider) {
	if (!raw) return false;
	if (!isOpenAICodexScopeContext(raw, provider)) return false;
	const inferred = typeof status === "number" && Number.isFinite(status) ? status : extractLeadingHttpStatus(raw.trim())?.code;
	const hasScopeHint = AUTH_SCOPE_HINT_RE.test(raw);
	const hasKnownScopeName = AUTH_SCOPE_NAME_RE.test(raw);
	if (!hasScopeHint && !hasKnownScopeName) return false;
	if (typeof inferred !== "number") return hasScopeHint;
	if (inferred !== 401 && inferred !== 403) return false;
	return true;
}
function isProxyErrorMessage(raw, status) {
	if (!raw) return false;
	if (status === 407) return true;
	return PROXY_ERROR_RE.test(raw);
}
function isDnsTransportErrorMessage(raw) {
	return DNS_ERROR_RE.test(raw);
}
function isReplayInvalidErrorMessage(raw) {
	return REPLAY_INVALID_RE.test(raw);
}
function isSandboxBlockedErrorMessage(raw) {
	return Boolean(formatExecDeniedUserMessage(raw)) || SANDBOX_BLOCKED_RE.test(raw);
}
function isSchemaErrorMessage(raw) {
	if (!raw || isReplayInvalidErrorMessage(raw) || isContextOverflowError(raw)) return false;
	return classifyFailoverReason(raw) === "format" || matchesFormatErrorPattern(raw);
}
function isTimeoutTransportErrorMessage(raw, status) {
	if (!raw) return false;
	if (isTimeoutErrorMessage(raw) || INTERRUPTED_NETWORK_ERROR_RE.test(raw)) return true;
	if (typeof status === "number" && [
		408,
		499,
		500,
		502,
		503,
		504,
		521,
		522,
		523,
		524,
		529
	].includes(status)) return true;
	return false;
}
function isOAuthRefreshTimeoutMessage(raw) {
	return /\boauth refresh call\b.*\bexceeded hard timeout\b/i.test(raw);
}
function isOAuthRefreshContentionMessage(raw) {
	return /\brefresh_contention\b/i.test(raw) || /\bfile lock timeout\b/i.test(raw) && /(?:\/|\\|^)(?:oauth-refresh|openclaw-oauth-refresh)[^/\n\\]*?(?:\.lock)?\b/i.test(raw);
}
function isOAuthCallbackTimeoutMessage(raw) {
	return /\bcallback_timeout\b/i.test(raw);
}
function isOAuthCallbackValidationMessage(raw) {
	return /\bcallback_validation_failed\b/i.test(raw);
}
function includesAnyHint(text, hints) {
	return hints.some((hint) => text.includes(hint));
}
function hasExplicit402BillingSignal(text) {
	return includesAnyHint(text, BILLING_402_HINTS) || includesAnyHint(text, BILLING_402_PLAN_HINTS) && text.includes("limit") || text.includes("billing hard limit") || text.includes("hard limit reached") || text.includes("maximum allowed") && text.includes("limit");
}
function hasQuotaRefreshWindowSignal(text) {
	return text.includes("subscription quota limit") && (text.includes("automatic quota refresh") || text.includes("rolling time window"));
}
function hasRetryable402TransientSignal(text) {
	const hasPeriodicHint = includesAnyHint(text, PERIODIC_402_HINTS);
	const hasSpendLimit = text.includes("spend limit") || text.includes("spending limit");
	const hasScopedHint = includesAnyHint(text, RETRYABLE_402_SCOPED_HINTS);
	return includesAnyHint(text, RETRYABLE_402_RETRY_HINTS) && includesAnyHint(text, RETRYABLE_402_LIMIT_HINTS) || hasPeriodicHint && (text.includes("usage limit") || hasSpendLimit) || hasPeriodicHint && text.includes("limit") && text.includes("reset") || hasScopedHint && text.includes("limit") && (hasSpendLimit || includesAnyHint(text, RETRYABLE_402_SCOPED_RESULT_HINTS));
}
function hasKnownBareLeading402Signal(text) {
	return hasQuotaRefreshWindowSignal(text) || hasExplicit402BillingSignal(text) || isRateLimitErrorMessage(text) || hasRetryable402TransientSignal(text);
}
function normalize402Message(raw) {
	return normalizeOptionalLowercaseString(raw)?.replace(LEADING_402_WRAPPER_RE, "").trim() ?? "";
}
function classify402Message(message) {
	const normalized = normalize402Message(message);
	if (!normalized) return "billing";
	if (hasQuotaRefreshWindowSignal(normalized)) return "rate_limit";
	if (hasExplicit402BillingSignal(normalized)) return "billing";
	if (isRateLimitErrorMessage(normalized)) return "rate_limit";
	if (hasRetryable402TransientSignal(normalized)) return "rate_limit";
	return "billing";
}
function classifyFailoverReasonFrom402Text(raw) {
	if (RAW_402_MARKER_RE.test(raw)) return classify402Message(raw);
	if (!BARE_LEADING_402_RE.test(raw)) return null;
	const normalized = normalize402Message(raw);
	if (!normalized || !hasKnownBareLeading402Signal(normalized)) return null;
	return classify402Message(raw);
}
function toReasonClassification(reason) {
	return {
		kind: "reason",
		reason
	};
}
function failoverReasonFromClassification(classification) {
	return classification?.kind === "reason" ? classification.reason : null;
}
function isTransientHttpError(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	const status = extractLeadingHttpStatus(trimmed);
	if (!status) return false;
	return TRANSIENT_HTTP_ERROR_CODES.has(status.code);
}
function classifyFailoverClassificationFromHttpStatus(status, message, messageClassification, explicitStatus, provider) {
	const messageReason = failoverReasonFromClassification(messageClassification);
	if (typeof status !== "number" || !Number.isFinite(status)) return null;
	if (status === 402) {
		if (!message) return toReasonClassification("billing");
		if (extractLeadingHttpStatus(message.trim())?.code === 402) {
			const reasonFrom402Text = classifyFailoverReasonFrom402Text(message);
			if (reasonFrom402Text) return toReasonClassification(reasonFrom402Text);
			return typeof explicitStatus === "number" ? toReasonClassification(classify402Message(message)) : messageClassification;
		}
		return toReasonClassification(classify402Message(message));
	}
	if (status === 429) {
		if (message && (isProvider(provider, "moonshot") || isProvider(provider, "kimi")) && isBillingErrorMessage(message)) return toReasonClassification("billing");
		return toReasonClassification("rate_limit");
	}
	if (status === 401 || status === 403) {
		if (message && isAuthPermanentErrorMessage(message)) return toReasonClassification("auth_permanent");
		if (messageReason === "billing") return toReasonClassification("billing");
		return toReasonClassification("auth");
	}
	if (status === 408) return toReasonClassification("timeout");
	if (status === 410) {
		if (messageReason === "session_expired" || messageReason === "billing" || messageReason === "auth_permanent" || messageReason === "auth") return messageClassification;
		return toReasonClassification("timeout");
	}
	if (status === 404) {
		if (messageClassification?.kind === "context_overflow") return messageClassification;
		if (messageReason === "session_expired" || messageReason === "billing" || messageReason === "auth_permanent" || messageReason === "auth") return messageClassification;
		return toReasonClassification("model_not_found");
	}
	if (status === 503) {
		if (messageReason === "overloaded") return messageClassification;
		return toReasonClassification("timeout");
	}
	if (status === 499) {
		if (messageReason === "overloaded") return messageClassification;
		return toReasonClassification("timeout");
	}
	if (status === 500 || status === 502 || status === 504) {
		if (messageReason === "server_error") return messageClassification;
		return toReasonClassification("timeout");
	}
	if (status === 529) return toReasonClassification("overloaded");
	if (status === 400 || status === 422) {
		if (messageClassification && messageReason !== "server_error") return messageClassification;
		if (isUnclassifiedNoBodyHttpSignal({
			status,
			message
		})) return null;
		return toReasonClassification("format");
	}
	return null;
}
function classifyFailoverReasonFromCode(raw) {
	const normalized = raw?.trim().toUpperCase();
	if (!normalized) return null;
	switch (normalized) {
		case "RESOURCE_EXHAUSTED":
		case "RATE_LIMIT":
		case "RATE_LIMITED":
		case "RATE_LIMIT_EXCEEDED":
		case "TOO_MANY_REQUESTS":
		case "THROTTLED":
		case "THROTTLING":
		case "THROTTLINGEXCEPTION":
		case "THROTTLING_EXCEPTION": return "rate_limit";
		case "DEACTIVATED_WORKSPACE": return "auth_permanent";
		case "OVERLOADED":
		case "OVERLOADED_ERROR": return "overloaded";
		default: return TIMEOUT_ERROR_CODES.has(normalized) ? "timeout" : null;
	}
}
function isProvider(provider, match) {
	const normalized = normalizeOptionalLowercaseString(provider);
	return Boolean(normalized && normalized.includes(match));
}
function isGenericUnknownStreamError(raw) {
	return /^\s*an unknown error occurred\.?\s*$/i.test(raw);
}
function isOpenRouterProviderReturnedError(raw, provider) {
	return isProvider(provider, "openrouter") && (normalizeOptionalLowercaseString(raw)?.includes("provider returned error") ?? false);
}
function isOpenRouterKeyLimitExceededError(raw, provider) {
	return isProvider(provider, "openrouter") && /\bkey\s+limit\s*(?:exceeded|reached|hit)\b/i.test(raw);
}
function isOpenRouterKeyBudgetLimitExceededError(raw, provider) {
	return isProvider(provider, "openrouter") && /\bapi\s+key\s+budget\s+limit\s*(?:exceeded|reached|hit)\b/i.test(raw);
}
function isExactUnknownNoDetailsError(raw) {
	return normalizeOptionalLowercaseString(raw)?.trim() === "unknown error (no error details in response)";
}
function classifyFailoverClassificationFromMessage(raw, provider) {
	if (isImageDimensionErrorMessage(raw)) return null;
	if (isImageSizeError(raw)) return null;
	if (isCliSessionExpiredErrorMessage(raw)) return toReasonClassification("session_expired");
	if (isModelNotFoundErrorMessage(raw)) return toReasonClassification("model_not_found");
	if (isContextOverflowError(raw)) return { kind: "context_overflow" };
	const reasonFrom402Text = classifyFailoverReasonFrom402Text(raw);
	if (reasonFrom402Text) return toReasonClassification(reasonFrom402Text);
	if (isOpenRouterKeyLimitExceededError(raw, provider) || isOpenRouterKeyBudgetLimitExceededError(raw, provider)) return toReasonClassification("billing");
	if (isPeriodicUsageLimitErrorMessage(raw)) return toReasonClassification(isBillingErrorMessage(raw) ? "billing" : "rate_limit");
	if (isRateLimitErrorMessage(raw)) return toReasonClassification("rate_limit");
	if (isOverloadedErrorMessage(raw)) return toReasonClassification("overloaded");
	if (isStructuredServerErrorMessage(raw) && !isBillingErrorMessage(raw) && !isAuthPermanentErrorMessage(raw) && !isAuthErrorMessage(raw)) return toReasonClassification("server_error");
	if (isTransientHttpError(raw)) {
		if (extractLeadingHttpStatus(raw.trim())?.code === 529) return toReasonClassification("overloaded");
		return toReasonClassification("timeout");
	}
	if (isGenericProviderInternalError(raw)) return toReasonClassification("timeout");
	if (isBillingErrorMessage(raw)) return toReasonClassification("billing");
	if (classifyOAuthRefreshFailure(raw)?.reason) return toReasonClassification("auth_permanent");
	if (isAuthPermanentErrorMessage(raw)) return toReasonClassification("auth_permanent");
	if (isAuthErrorMessage(raw)) return toReasonClassification("auth");
	if (isGenericUnknownStreamError(raw)) return toReasonClassification("timeout");
	if (isOpenRouterProviderReturnedError(raw, provider)) return toReasonClassification("timeout");
	if (isServerErrorMessage(raw)) return toReasonClassification("timeout");
	if (isJsonApiInternalServerError(raw)) return toReasonClassification("timeout");
	if (isCloudCodeAssistFormatError(raw)) return toReasonClassification("format");
	if (isExactUnknownNoDetailsError(raw)) return toReasonClassification("no_error_details");
	if (isTimeoutErrorMessage(raw)) return toReasonClassification("timeout");
	const providerSpecific = classifyProviderSpecificError(raw);
	if (providerSpecific) return toReasonClassification(providerSpecific);
	return null;
}
function classifyFailoverSignal(signal) {
	const inferredStatus = inferSignalStatus(signal);
	if (signal.message && isTransportHtmlErrorStatus(inferredStatus) && isHtmlErrorResponse(signal.message, inferredStatus)) return toReasonClassification("timeout");
	const messageClassification = signal.message ? classifyFailoverClassificationFromMessage(signal.message, signal.provider) : null;
	const codeReason = classifyFailoverReasonFromCode(signal.code);
	if (codeReason === "auth_permanent") return toReasonClassification(codeReason);
	const statusClassification = classifyFailoverClassificationFromHttpStatus(inferredStatus, signal.message, messageClassification, signal.status, signal.provider);
	if (statusClassification) return statusClassification;
	if (codeReason) return toReasonClassification(codeReason);
	return messageClassification;
}
function classifyProviderRuntimeFailureKind(signal) {
	const normalizedSignal = typeof signal === "string" ? { message: signal } : signal;
	const message = normalizedSignal.message?.trim() ?? "";
	const status = inferSignalStatus(normalizedSignal);
	if (!message && typeof status !== "number") return "empty_response";
	if (normalizedSignal.code === "refresh_contention") return "refresh_contention";
	if (message && isOAuthRefreshContentionMessage(message)) return "refresh_contention";
	if (message && isOAuthRefreshTimeoutMessage(message)) return "refresh_timeout";
	if (message && isOAuthCallbackTimeoutMessage(message)) return "callback_timeout";
	if (message && isOAuthCallbackValidationMessage(message)) return "callback_validation";
	if (message && classifyOAuthRefreshFailure(message)) return "auth_refresh";
	if (message && isAuthScopeErrorMessage(message, status, normalizedSignal.provider)) return "auth_scope";
	if (message && isProxyErrorMessage(message, status)) return "proxy";
	if (message && isHtmlErrorResponse(message, status)) return status === 401 || status === 403 ? "auth_html" : "upstream_html";
	const failoverClassification = classifyFailoverSignal({
		...normalizedSignal,
		status,
		message: message || void 0
	});
	if (failoverClassification?.kind === "reason" && failoverClassification.reason === "rate_limit") return "rate_limit";
	if (message && isDnsTransportErrorMessage(message)) return "dns";
	if (message && isSandboxBlockedErrorMessage(message)) return "sandbox_blocked";
	if (message && isReplayInvalidErrorMessage(message)) return "replay_invalid";
	if (message && isSchemaErrorMessage(message)) return "schema";
	if (failoverClassification?.kind === "reason" && (failoverClassification.reason === "timeout" || failoverClassification.reason === "overloaded")) return "timeout";
	if (message && isTimeoutTransportErrorMessage(message, status)) return "timeout";
	if (message && isExactUnknownNoDetailsError(message)) return "no_error_details";
	return "unclassified";
}
function formatAssistantErrorText(msg, opts) {
	const raw = (msg.errorMessage ?? "").trim();
	if (msg.stopReason !== "error" && !raw) return;
	if (!raw) return "LLM request failed with an unknown error.";
	const providerRuntimeFailureKind = classifyProviderRuntimeFailureKind({
		status: extractLeadingHttpStatus(raw)?.code,
		message: raw,
		provider: opts?.provider ?? msg.provider
	});
	const unknownTool = raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ?? raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
	if (unknownTool?.[1]) {
		const rewritten = formatSandboxToolPolicyBlockedMessage({
			cfg: opts?.cfg,
			sessionKey: opts?.sessionKey,
			toolName: unknownTool[1]
		});
		if (rewritten) return rewritten;
	}
	const diskSpaceCopy = formatDiskSpaceErrorCopy(raw);
	if (diskSpaceCopy) return diskSpaceCopy;
	if (providerRuntimeFailureKind === "auth_refresh") return "Authentication refresh failed. Re-authenticate this provider and try again.";
	if (providerRuntimeFailureKind === "refresh_contention") return "Authentication refresh is already in progress elsewhere and this attempt timed out waiting for it. Retry in a moment.";
	if (providerRuntimeFailureKind === "refresh_timeout") return "Authentication refresh timed out before the provider completed. Retry in a moment; re-authenticate only if it keeps failing.";
	if (providerRuntimeFailureKind === "callback_timeout") return "Browser OAuth did not complete before manual fallback kicked in. Retry the login flow and paste the redirect URL if prompted.";
	if (providerRuntimeFailureKind === "callback_validation") return "Browser OAuth returned an invalid or incomplete callback. Retry the login flow and make sure the full redirect URL is pasted if prompted.";
	if (providerRuntimeFailureKind === "auth_scope") return "Authentication is missing the required OpenAI Codex scopes. Re-run OpenAI/Codex login and try again.";
	if (providerRuntimeFailureKind === "auth_html") return "Authentication failed at the provider. Re-authenticate and verify your provider credentials and account access.";
	if (providerRuntimeFailureKind === "upstream_html") return "The provider returned an HTML error page instead of an API response. This usually means a CDN or gateway (e.g. Cloudflare) blocked the request. Retry in a moment or check provider status.";
	if (providerRuntimeFailureKind === "proxy") return "LLM request failed: proxy or tunnel configuration blocked the provider request.";
	if (isContextOverflowError(raw)) return "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
	if (isReasoningConstraintErrorMessage(raw)) return "Reasoning is required for this model endpoint. Use /think minimal (or any non-off level) and try again.";
	if (isInvalidStreamingEventOrderError(raw)) return "LLM request failed: provider returned an invalid streaming response. Please try again.";
	if (/incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(raw)) return "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
	if (isMissingToolCallInputError(raw)) return "Session history looks corrupted (tool call input missing). Use /new to start a fresh session. If this keeps happening, reset the session or delete the corrupted session transcript.";
	const invalidRequest = raw.match(/"type":"invalid_request_error".*?"message":"([^"]+)"/);
	if (invalidRequest?.[1]) return `LLM request rejected: ${invalidRequest[1]}`;
	const transientCopy = formatRateLimitOrOverloadedErrorCopy(raw);
	if (transientCopy) return transientCopy;
	if (isGenericProviderInternalError(raw)) return formatRawAssistantErrorForUi(raw);
	const transportCopy = formatTransportErrorCopy(raw);
	if (transportCopy) return transportCopy;
	if (isTimeoutErrorMessage(raw)) return "LLM request timed out.";
	if (isBillingErrorMessage(raw)) return formatBillingErrorMessage(opts?.provider, opts?.model ?? msg.model);
	if (providerRuntimeFailureKind === "schema") return "LLM request failed: provider rejected the request schema or tool payload.";
	if (providerRuntimeFailureKind === "replay_invalid") return "Session history or replay state is invalid. Use /new to start a fresh session and try again.";
	if (isLikelyHttpErrorText(raw) || isRawApiErrorPayload(raw)) return formatRawAssistantErrorForUi(raw);
	if (isStreamingJsonParseError(raw)) return "LLM streaming response contained a malformed fragment. Please try again.";
	if (raw.length > 600) log.warn(`Long error truncated: ${raw.slice(0, 200)}`);
	return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}
function isRateLimitAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isRateLimitErrorMessage(msg.errorMessage ?? "");
}
const TOOL_CALL_INPUT_MISSING_RE = /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE = /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;
const IMAGE_DIMENSION_ERROR_RE = /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;
const IMAGE_DIMENSION_PATH_RE = /messages\.(\d+)\.content\.(\d+)\.image/i;
const IMAGE_SIZE_ERROR_RE = /image exceeds\s*(\d+(?:\.\d+)?)\s*mb/i;
function isMissingToolCallInputError(raw) {
	if (!raw) return false;
	return TOOL_CALL_INPUT_MISSING_RE.test(raw) || TOOL_CALL_INPUT_PATH_RE.test(raw);
}
function isBillingAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isBillingErrorMessage(msg.errorMessage ?? "");
}
const API_ERROR_TRANSIENT_SIGNALS_RE = /internal server error|overload|temporarily unavailable|service unavailable|unknown error|server error|bad gateway|gateway timeout|upstream error|backend error|try again later|temporarily.+unable|unexpected error/i;
function isJsonApiInternalServerError(raw) {
	if (!raw) return false;
	if (!normalizeLowercaseStringOrEmpty(raw).includes("\"type\":\"api_error\"")) return false;
	if (isBillingErrorMessage(raw) || isAuthErrorMessage(raw) || isAuthPermanentErrorMessage(raw)) return false;
	return API_ERROR_TRANSIENT_SIGNALS_RE.test(raw);
}
function isStructuredServerErrorMessage(raw) {
	if (!raw) return false;
	const value = normalizeLowercaseStringOrEmpty(raw);
	return value.includes("\"type\":\"server_error\"") || value.includes("\"code\":\"server_error\"");
}
function parseImageDimensionError(raw) {
	if (!raw) return null;
	if (!normalizeLowercaseStringOrEmpty(raw).includes("image dimensions exceed max allowed size")) return null;
	const limitMatch = raw.match(IMAGE_DIMENSION_ERROR_RE);
	const pathMatch = raw.match(IMAGE_DIMENSION_PATH_RE);
	return {
		maxDimensionPx: limitMatch?.[1] ? Number.parseInt(limitMatch[1], 10) : void 0,
		messageIndex: pathMatch?.[1] ? Number.parseInt(pathMatch[1], 10) : void 0,
		contentIndex: pathMatch?.[2] ? Number.parseInt(pathMatch[2], 10) : void 0,
		raw
	};
}
function isImageDimensionErrorMessage(raw) {
	return Boolean(parseImageDimensionError(raw));
}
function parseImageSizeError(raw) {
	if (!raw) return null;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	if (!lower.includes("image exceeds") || !lower.includes("mb")) return null;
	const match = raw.match(IMAGE_SIZE_ERROR_RE);
	return {
		maxMb: match?.[1] ? Number.parseFloat(match[1]) : void 0,
		raw
	};
}
function isImageSizeError(errorMessage) {
	if (!errorMessage) return false;
	return Boolean(parseImageSizeError(errorMessage));
}
function isCloudCodeAssistFormatError(raw) {
	return !isImageDimensionErrorMessage(raw) && matchesFormatErrorPattern(raw);
}
function isAuthAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isAuthErrorMessage(msg.errorMessage ?? "");
}
function isCliSessionExpiredErrorMessage(raw) {
	if (!raw) return false;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	return lower.includes("session not found") || lower.includes("session does not exist") || lower.includes("session expired") || lower.includes("session invalid") || lower.includes("conversation not found") || lower.includes("no conversation found") || lower.includes("conversation does not exist") || lower.includes("conversation expired") || lower.includes("conversation invalid") || lower.includes("no such session") || lower.includes("invalid session") || lower.includes("session id not found") || lower.includes("conversation id not found");
}
function classifyFailoverReason(raw, opts) {
	return failoverReasonFromClassification(classifyFailoverSignal({
		message: raw,
		provider: opts?.provider
	}));
}
function isFailoverErrorMessage(raw, opts) {
	return classifyFailoverReason(raw, opts) !== null;
}
function isFailoverAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isFailoverErrorMessage(msg.errorMessage ?? "", { provider: msg.provider });
}
//#endregion
export { parseImageSizeError as S, isRateLimitAssistantError as _, formatAssistantErrorText as a, isUnclassifiedNoBodyHttpSignal as b, isBillingAssistantError as c, isContextOverflowError as d, isFailoverAssistantError as f, isLikelyContextOverflowError as g, isImageSizeError as h, extractObservedOverflowTokenCount as i, isCloudCodeAssistFormatError as l, isImageDimensionErrorMessage as m, classifyFailoverSignal as n, inferSignalStatus as o, isFailoverErrorMessage as p, classifyProviderRuntimeFailureKind as r, isAuthAssistantError as s, classifyFailoverReason as t, isCompactionFailureError as u, isReasoningConstraintErrorMessage as v, parseImageDimensionError as x, isTransientHttpError as y };
