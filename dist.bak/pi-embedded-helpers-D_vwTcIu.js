import { E as truncateUtf16Safe } from "./utils-BKDT474X.js";
import { s as normalizeThinkLevel } from "./thinking-EAliFiVK.js";
import { t as createSubsystemLogger } from "./subsystem-LTWJBEIv.js";
import { s as formatSandboxToolPolicyBlockedMessage } from "./sandbox-Dyhzzmyi.js";
import { t as sanitizeContentBlocksImages } from "./tool-images-al3PxqY4.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

//#region src/agents/pi-embedded-helpers/bootstrap.ts
function isBase64Signature(value) {
	const trimmed = value.trim();
	if (!trimmed) return false;
	const compact = trimmed.replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/=_-]+$/.test(compact)) return false;
	const isUrl = compact.includes("-") || compact.includes("_");
	try {
		const buf = Buffer.from(compact, isUrl ? "base64url" : "base64");
		if (buf.length === 0) return false;
		const encoded = buf.toString(isUrl ? "base64url" : "base64");
		const normalize = (input) => input.replace(/=+$/g, "");
		return normalize(encoded) === normalize(compact);
	} catch {
		return false;
	}
}
/**
* Strips Claude-style thought_signature fields from content blocks.
*
* Gemini expects thought signatures as base64-encoded bytes, but Claude stores message ids
* like "msg_abc123...". We only strip "msg_*" to preserve any provider-valid signatures.
*/
function stripThoughtSignatures(content, options) {
	if (!Array.isArray(content)) return content;
	const allowBase64Only = options?.allowBase64Only ?? false;
	const includeCamelCase = options?.includeCamelCase ?? false;
	const shouldStripSignature = (value) => {
		if (!allowBase64Only) return typeof value === "string" && value.startsWith("msg_");
		return typeof value !== "string" || !isBase64Signature(value);
	};
	return content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const rec = block;
		const stripSnake = shouldStripSignature(rec.thought_signature);
		const stripCamel = includeCamelCase ? shouldStripSignature(rec.thoughtSignature) : false;
		if (!stripSnake && !stripCamel) return block;
		const next = { ...rec };
		if (stripSnake) delete next.thought_signature;
		if (stripCamel) delete next.thoughtSignature;
		return next;
	});
}
const DEFAULT_BOOTSTRAP_MAX_CHARS = 2e4;
const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 15e4;
const MIN_BOOTSTRAP_FILE_BUDGET_CHARS = 64;
const BOOTSTRAP_HEAD_RATIO = .7;
const BOOTSTRAP_TAIL_RATIO = .2;
function resolveBootstrapMaxChars(cfg) {
	const raw = cfg?.agents?.defaults?.bootstrapMaxChars;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_BOOTSTRAP_MAX_CHARS;
}
function resolveBootstrapTotalMaxChars(cfg) {
	const raw = cfg?.agents?.defaults?.bootstrapTotalMaxChars;
	if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	return DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
}
function trimBootstrapContent(content, fileName, maxChars) {
	const trimmed = content.trimEnd();
	if (trimmed.length <= maxChars) return {
		content: trimmed,
		truncated: false,
		maxChars,
		originalLength: trimmed.length
	};
	const headChars = Math.floor(maxChars * BOOTSTRAP_HEAD_RATIO);
	const tailChars = Math.floor(maxChars * BOOTSTRAP_TAIL_RATIO);
	const head = trimmed.slice(0, headChars);
	const tail = trimmed.slice(-tailChars);
	return {
		content: [
			head,
			[
				"",
				`[...truncated, read ${fileName} for full content...]`,
				`…(truncated ${fileName}: kept ${headChars}+${tailChars} chars of ${trimmed.length})…`,
				""
			].join("\n"),
			tail
		].join("\n"),
		truncated: true,
		maxChars,
		originalLength: trimmed.length
	};
}
function clampToBudget(content, budget) {
	if (budget <= 0) return "";
	if (content.length <= budget) return content;
	if (budget <= 3) return truncateUtf16Safe(content, budget);
	return `${truncateUtf16Safe(content, budget - 1)}…`;
}
async function ensureSessionHeader(params) {
	const file = params.sessionFile;
	try {
		await fs.stat(file);
		return;
	} catch {}
	await fs.mkdir(path.dirname(file), { recursive: true });
	const entry = {
		type: "session",
		version: 2,
		id: params.sessionId,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		cwd: params.cwd
	};
	await fs.writeFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}
function buildBootstrapContextFiles(files, opts) {
	const maxChars = opts?.maxChars ?? DEFAULT_BOOTSTRAP_MAX_CHARS;
	let remainingTotalChars = Math.max(1, Math.floor(opts?.totalMaxChars ?? Math.max(maxChars, DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS)));
	const result = [];
	for (const file of files) {
		if (remainingTotalChars <= 0) break;
		const pathValue = typeof file.path === "string" ? file.path.trim() : "";
		if (!pathValue) {
			opts?.warn?.(`skipping bootstrap file "${file.name}" — missing or invalid "path" field (hook may have used "filePath" instead)`);
			continue;
		}
		if (file.missing) {
			const cappedMissingText = clampToBudget(`[MISSING] Expected at: ${pathValue}`, remainingTotalChars);
			if (!cappedMissingText) break;
			remainingTotalChars = Math.max(0, remainingTotalChars - cappedMissingText.length);
			result.push({
				path: pathValue,
				content: cappedMissingText
			});
			continue;
		}
		if (remainingTotalChars < MIN_BOOTSTRAP_FILE_BUDGET_CHARS) {
			opts?.warn?.(`remaining bootstrap budget is ${remainingTotalChars} chars (<${MIN_BOOTSTRAP_FILE_BUDGET_CHARS}); skipping additional bootstrap files`);
			break;
		}
		const fileMaxChars = Math.max(1, Math.min(maxChars, remainingTotalChars));
		const trimmed = trimBootstrapContent(file.content ?? "", file.name, fileMaxChars);
		const contentWithinBudget = clampToBudget(trimmed.content, remainingTotalChars);
		if (!contentWithinBudget) continue;
		if (trimmed.truncated || contentWithinBudget.length < trimmed.content.length) opts?.warn?.(`workspace bootstrap file ${file.name} is ${trimmed.originalLength} chars (limit ${trimmed.maxChars}); truncating in injected context`);
		remainingTotalChars = Math.max(0, remainingTotalChars - contentWithinBudget.length);
		result.push({
			path: pathValue,
			content: contentWithinBudget
		});
	}
	return result;
}
function sanitizeGoogleTurnOrdering(messages) {
	const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";
	const first = messages[0];
	const role = first?.role;
	const content = first?.content;
	if (role === "user" && typeof content === "string" && content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT) return messages;
	if (role !== "assistant") return messages;
	return [{
		role: "user",
		content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
		timestamp: Date.now()
	}, ...messages];
}

//#endregion
//#region src/agents/stable-stringify.ts
function stableStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	const record = value;
	return `{${Object.keys(record).toSorted().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

//#endregion
//#region src/agents/pi-embedded-helpers/errors.ts
const log = createSubsystemLogger("errors");
function formatBillingErrorMessage(provider, model) {
	const providerName = provider?.trim();
	const modelName = model?.trim();
	const providerLabel = providerName && modelName ? `${providerName} (${modelName})` : providerName || void 0;
	if (providerLabel) return `⚠️ ${providerLabel} returned a billing error — your API key has run out of credits or has an insufficient balance. Check your ${providerName} billing dashboard and top up or switch to a different API key.`;
	return "⚠️ API provider returned a billing error — your API key has run out of credits or has an insufficient balance. Check your provider's billing dashboard and top up or switch to a different API key.";
}
const BILLING_ERROR_USER_MESSAGE = formatBillingErrorMessage();
const RATE_LIMIT_ERROR_USER_MESSAGE = "⚠️ API rate limit reached. Please try again later.";
const OVERLOADED_ERROR_USER_MESSAGE = "The AI service is temporarily overloaded. Please try again in a moment.";
function formatRateLimitOrOverloadedErrorCopy(raw) {
	if (isRateLimitErrorMessage(raw)) return RATE_LIMIT_ERROR_USER_MESSAGE;
	if (isOverloadedErrorMessage(raw)) return OVERLOADED_ERROR_USER_MESSAGE;
}
function isReasoningConstraintErrorMessage(raw) {
	if (!raw) return false;
	const lower = raw.toLowerCase();
	return lower.includes("reasoning is mandatory") || lower.includes("reasoning is required") || lower.includes("requires reasoning") || lower.includes("reasoning") && lower.includes("cannot be disabled");
}
function isContextOverflowError(errorMessage) {
	if (!errorMessage) return false;
	const lower = errorMessage.toLowerCase();
	if (lower.includes("tpm") || lower.includes("tokens per minute")) return false;
	if (isReasoningConstraintErrorMessage(errorMessage)) return false;
	const hasRequestSizeExceeds = lower.includes("request size exceeds");
	const hasContextWindow = lower.includes("context window") || lower.includes("context length") || lower.includes("maximum context length");
	return lower.includes("request_too_large") || lower.includes("request exceeds the maximum size") || lower.includes("context length exceeded") || lower.includes("maximum context length") || lower.includes("prompt is too long") || lower.includes("exceeds model context window") || lower.includes("model token limit") || hasRequestSizeExceeds && hasContextWindow || lower.includes("context overflow:") || lower.includes("exceed context limit") || lower.includes("exceeds the model's maximum context") || lower.includes("max_tokens") && lower.includes("exceed") && lower.includes("context") || lower.includes("input length") && lower.includes("exceed") && lower.includes("context") || lower.includes("413") && lower.includes("too large") || errorMessage.includes("上下文过长") || errorMessage.includes("上下文超出") || errorMessage.includes("上下文长度超") || errorMessage.includes("超出最大上下文") || errorMessage.includes("请压缩上下文");
}
const CONTEXT_WINDOW_TOO_SMALL_RE = /context window.*(too small|minimum is)/i;
const CONTEXT_OVERFLOW_HINT_RE = /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i;
const RATE_LIMIT_HINT_RE = /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b/i;
function isLikelyContextOverflowError(errorMessage) {
	if (!errorMessage) return false;
	const lower = errorMessage.toLowerCase();
	if (lower.includes("tpm") || lower.includes("tokens per minute")) return false;
	if (isReasoningConstraintErrorMessage(errorMessage)) return false;
	if (CONTEXT_WINDOW_TOO_SMALL_RE.test(errorMessage)) return false;
	if (isRateLimitErrorMessage(errorMessage)) return false;
	if (isContextOverflowError(errorMessage)) return true;
	if (RATE_LIMIT_HINT_RE.test(errorMessage)) return false;
	return CONTEXT_OVERFLOW_HINT_RE.test(errorMessage);
}
function isCompactionFailureError(errorMessage) {
	if (!errorMessage) return false;
	const lower = errorMessage.toLowerCase();
	if (!(lower.includes("summarization failed") || lower.includes("auto-compaction") || lower.includes("compaction failed") || lower.includes("compaction"))) return false;
	if (isLikelyContextOverflowError(errorMessage)) return true;
	return lower.includes("context overflow");
}
const ERROR_PAYLOAD_PREFIX_RE = /^(?:error|api\s*error|apierror|openai\s*error|anthropic\s*error|gateway\s*error)[:\s-]+/i;
const FINAL_TAG_RE = /<\s*\/?\s*final\s*>/gi;
const ERROR_PREFIX_RE = /^(?:error|api\s*error|openai\s*error|anthropic\s*error|gateway\s*error|request failed|failed|exception)[:\s-]+/i;
const CONTEXT_OVERFLOW_ERROR_HEAD_RE = /^(?:context overflow:|request_too_large\b|request size exceeds\b|request exceeds the maximum size\b|context length exceeded\b|maximum context length\b|prompt is too long\b|exceeds model context window\b)/i;
const BILLING_ERROR_HEAD_RE = /^(?:error[:\s-]+)?billing(?:\s+error)?(?:[:\s-]+|$)|^(?:error[:\s-]+)?(?:credit balance|insufficient credits?|payment required|http\s*402\b)/i;
const BILLING_ERROR_HARD_402_RE = /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|^\s*402\s+payment/i;
const HTTP_STATUS_PREFIX_RE = /^(?:http\s*)?(\d{3})\s+(.+)$/i;
const HTTP_STATUS_CODE_PREFIX_RE = /^(?:http\s*)?(\d{3})(?:\s+([\s\S]+))?$/i;
const HTML_ERROR_PREFIX_RE = /^\s*(?:<!doctype\s+html\b|<html\b)/i;
const CLOUDFLARE_HTML_ERROR_CODES = new Set([
	521,
	522,
	523,
	524,
	525,
	526,
	530
]);
const TRANSIENT_HTTP_ERROR_CODES = new Set([
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
function extractLeadingHttpStatus(raw) {
	const match = raw.match(HTTP_STATUS_CODE_PREFIX_RE);
	if (!match) return null;
	const code = Number(match[1]);
	if (!Number.isFinite(code)) return null;
	return {
		code,
		rest: (match[2] ?? "").trim()
	};
}
function isCloudflareOrHtmlErrorPage(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	const status = extractLeadingHttpStatus(trimmed);
	if (!status || status.code < 500) return false;
	if (CLOUDFLARE_HTML_ERROR_CODES.has(status.code)) return true;
	return status.code < 600 && HTML_ERROR_PREFIX_RE.test(status.rest) && /<\/html>/i.test(status.rest);
}
function isTransientHttpError(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return false;
	const status = extractLeadingHttpStatus(trimmed);
	if (!status) return false;
	return TRANSIENT_HTTP_ERROR_CODES.has(status.code);
}
function stripFinalTagsFromText(text) {
	if (!text) return text;
	return text.replace(FINAL_TAG_RE, "");
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
	const match = raw.match(HTTP_STATUS_PREFIX_RE);
	if (!match) return false;
	const code = Number(match[1]);
	if (!Number.isFinite(code) || code < 400) return false;
	const message = match[2].toLowerCase();
	return HTTP_ERROR_HINTS.some((hint) => message.includes(hint));
}
function shouldRewriteContextOverflowText(raw) {
	if (!isContextOverflowError(raw)) return false;
	return isRawApiErrorPayload(raw) || isLikelyHttpErrorText(raw) || ERROR_PREFIX_RE.test(raw) || CONTEXT_OVERFLOW_ERROR_HEAD_RE.test(raw);
}
function isErrorPayloadObject(payload) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
	const record = payload;
	if (record.type === "error") return true;
	if (typeof record.request_id === "string" || typeof record.requestId === "string") return true;
	if ("error" in record) {
		const err = record.error;
		if (err && typeof err === "object" && !Array.isArray(err)) {
			const errRecord = err;
			if (typeof errRecord.message === "string" || typeof errRecord.type === "string" || typeof errRecord.code === "string") return true;
		}
	}
	return false;
}
function parseApiErrorPayload(raw) {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const candidates = [trimmed];
	if (ERROR_PAYLOAD_PREFIX_RE.test(trimmed)) candidates.push(trimmed.replace(ERROR_PAYLOAD_PREFIX_RE, "").trim());
	for (const candidate of candidates) {
		if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
		try {
			const parsed = JSON.parse(candidate);
			if (isErrorPayloadObject(parsed)) return parsed;
		} catch {}
	}
	return null;
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
function parseApiErrorInfo(raw) {
	if (!raw) return null;
	const trimmed = raw.trim();
	if (!trimmed) return null;
	let httpCode;
	let candidate = trimmed;
	const httpPrefixMatch = candidate.match(/^(\d{3})\s+(.+)$/s);
	if (httpPrefixMatch) {
		httpCode = httpPrefixMatch[1];
		candidate = httpPrefixMatch[2].trim();
	}
	const payload = parseApiErrorPayload(candidate);
	if (!payload) return null;
	const requestId = typeof payload.request_id === "string" ? payload.request_id : typeof payload.requestId === "string" ? payload.requestId : void 0;
	const topType = typeof payload.type === "string" ? payload.type : void 0;
	const topMessage = typeof payload.message === "string" ? payload.message : void 0;
	let errType;
	let errMessage;
	if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
		const err = payload.error;
		if (typeof err.type === "string") errType = err.type;
		if (typeof err.code === "string" && !errType) errType = err.code;
		if (typeof err.message === "string") errMessage = err.message;
	}
	return {
		httpCode,
		type: errType ?? topType,
		message: errMessage ?? topMessage,
		requestId
	};
}
function formatRawAssistantErrorForUi(raw) {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "LLM request failed with an unknown error.";
	const leadingStatus = extractLeadingHttpStatus(trimmed);
	if (leadingStatus && isCloudflareOrHtmlErrorPage(trimmed)) return `The AI service is temporarily unavailable (HTTP ${leadingStatus.code}). Please try again in a moment.`;
	const httpMatch = trimmed.match(HTTP_STATUS_PREFIX_RE);
	if (httpMatch) {
		const rest = httpMatch[2].trim();
		if (!rest.startsWith("{")) return `HTTP ${httpMatch[1]}: ${rest}`;
	}
	const info = parseApiErrorInfo(trimmed);
	if (info?.message) {
		const prefix = info.httpCode ? `HTTP ${info.httpCode}` : "LLM error";
		const type = info.type ? ` ${info.type}` : "";
		const requestId = info.requestId ? ` (request_id: ${info.requestId})` : "";
		return `${prefix}${type}: ${info.message}${requestId}`;
	}
	return trimmed.length > 600 ? `${trimmed.slice(0, 600)}…` : trimmed;
}
function formatAssistantErrorText(msg, opts) {
	const raw = (msg.errorMessage ?? "").trim();
	if (msg.stopReason !== "error" && !raw) return;
	if (!raw) return "LLM request failed with an unknown error.";
	const unknownTool = raw.match(/unknown tool[:\s]+["']?([a-z0-9_-]+)["']?/i) ?? raw.match(/tool\s+["']?([a-z0-9_-]+)["']?\s+(?:not found|is not available)/i);
	if (unknownTool?.[1]) {
		const rewritten = formatSandboxToolPolicyBlockedMessage({
			cfg: opts?.cfg,
			sessionKey: opts?.sessionKey,
			toolName: unknownTool[1]
		});
		if (rewritten) return rewritten;
	}
	if (isContextOverflowError(raw)) return "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
	if (isReasoningConstraintErrorMessage(raw)) return "Reasoning is required for this model endpoint. Use /think minimal (or any non-off level) and try again.";
	if (/incorrect role information|roles must alternate|400.*role|"message".*role.*information/i.test(raw)) return "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
	if (isMissingToolCallInputError(raw)) return "Session history looks corrupted (tool call input missing). Use /new to start a fresh session. If this keeps happening, reset the session or delete the corrupted session transcript.";
	const invalidRequest = raw.match(/"type":"invalid_request_error".*?"message":"([^"]+)"/);
	if (invalidRequest?.[1]) return `LLM request rejected: ${invalidRequest[1]}`;
	const transientCopy = formatRateLimitOrOverloadedErrorCopy(raw);
	if (transientCopy) return transientCopy;
	if (isTimeoutErrorMessage(raw)) return "LLM request timed out.";
	if (isBillingErrorMessage(raw)) return formatBillingErrorMessage(opts?.provider, opts?.model ?? msg.model);
	if (isLikelyHttpErrorText(raw) || isRawApiErrorPayload(raw)) return formatRawAssistantErrorForUi(raw);
	if (raw.length > 600) log.warn(`Long error truncated: ${raw.slice(0, 200)}`);
	return raw.length > 600 ? `${raw.slice(0, 600)}…` : raw;
}
function sanitizeUserFacingText(text, opts) {
	if (!text) return text;
	const errorContext = opts?.errorContext ?? false;
	const stripped = stripFinalTagsFromText(text);
	const trimmed = stripped.trim();
	if (!trimmed) return "";
	if (errorContext) {
		if (/incorrect role information|roles must alternate/i.test(trimmed)) return "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
		if (shouldRewriteContextOverflowText(trimmed)) return "Context overflow: prompt too large for the model. Try /reset (or /new) to start a fresh session, or use a larger-context model.";
		if (isBillingErrorMessage(trimmed)) return BILLING_ERROR_USER_MESSAGE;
		if (isRawApiErrorPayload(trimmed) || isLikelyHttpErrorText(trimmed)) return formatRawAssistantErrorForUi(trimmed);
		if (ERROR_PREFIX_RE.test(trimmed)) {
			const prefixedCopy = formatRateLimitOrOverloadedErrorCopy(trimmed);
			if (prefixedCopy) return prefixedCopy;
			if (isTimeoutErrorMessage(trimmed)) return "LLM request timed out.";
			return formatRawAssistantErrorForUi(trimmed);
		}
	}
	return collapseConsecutiveDuplicateBlocks(stripped.replace(/^(?:[ \t]*\r?\n)+/, ""));
}
function isRateLimitAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isRateLimitErrorMessage(msg.errorMessage ?? "");
}
const ERROR_PATTERNS = {
	rateLimit: [
		/rate[_ ]limit|too many requests|429/,
		"model_cooldown",
		"cooling down",
		"exceeded your current quota",
		"resource has been exhausted",
		"quota exceeded",
		"resource_exhausted",
		"usage limit",
		"tpm",
		"tokens per minute"
	],
	overloaded: [
		/overloaded_error|"type"\s*:\s*"overloaded_error"/i,
		"overloaded",
		"service unavailable",
		"high demand"
	],
	timeout: [
		"timeout",
		"timed out",
		"deadline exceeded",
		"context deadline exceeded",
		/without sending (?:any )?chunks?/i,
		/\bstop reason:\s*abort\b/i,
		/\breason:\s*abort\b/i,
		/\bunhandled stop reason:\s*abort\b/i
	],
	billing: [
		/["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+payment/i,
		"payment required",
		"insufficient credits",
		"credit balance",
		"plans & billing",
		"insufficient balance"
	],
	authPermanent: [
		/api[_ ]?key[_ ]?(?:revoked|invalid|deactivated|deleted)/i,
		"invalid_api_key",
		"key has been disabled",
		"key has been revoked",
		"account has been deactivated",
		/could not (?:authenticate|validate).*(?:api[_ ]?key|credentials)/i
	],
	auth: [
		/invalid[_ ]?api[_ ]?key/,
		"incorrect api key",
		"invalid token",
		"authentication",
		"re-authenticate",
		"oauth token refresh failed",
		"unauthorized",
		"forbidden",
		"access denied",
		"insufficient permissions",
		"insufficient permission",
		/missing scopes?:/i,
		"expired",
		"token has expired",
		/\b401\b/,
		/\b403\b/,
		"no credentials found",
		"no api key found"
	],
	format: [
		"string should match pattern",
		"tool_use.id",
		"tool_use_id",
		"messages.1.content.1.tool_use.id",
		"invalid request format",
		/tool call id was.*must be/i
	]
};
const TOOL_CALL_INPUT_MISSING_RE = /tool_(?:use|call)\.(?:input|arguments).*?(?:field required|required)/i;
const TOOL_CALL_INPUT_PATH_RE = /messages\.\d+\.content\.\d+\.tool_(?:use|call)\.(?:input|arguments)/i;
const IMAGE_DIMENSION_ERROR_RE = /image dimensions exceed max allowed size for many-image requests:\s*(\d+)\s*pixels/i;
const IMAGE_DIMENSION_PATH_RE = /messages\.(\d+)\.content\.(\d+)\.image/i;
const IMAGE_SIZE_ERROR_RE = /image exceeds\s*(\d+(?:\.\d+)?)\s*mb/i;
function matchesErrorPatterns(raw, patterns) {
	if (!raw) return false;
	const value = raw.toLowerCase();
	return patterns.some((pattern) => pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern));
}
function isRateLimitErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}
function isTimeoutErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}
/**
* Maximum character length for a string to be considered a billing error message.
* Real API billing errors are short, structured messages (typically under 300 chars).
* Longer text is almost certainly assistant content that happens to mention billing keywords.
*/
const BILLING_ERROR_MAX_LENGTH = 512;
function isBillingErrorMessage(raw) {
	const value = raw.toLowerCase();
	if (!value) return false;
	if (raw.length > BILLING_ERROR_MAX_LENGTH) return BILLING_ERROR_HARD_402_RE.test(value);
	if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) return true;
	if (!BILLING_ERROR_HEAD_RE.test(raw)) return false;
	return value.includes("upgrade") || value.includes("credits") || value.includes("payment") || value.includes("plan");
}
function isMissingToolCallInputError(raw) {
	if (!raw) return false;
	return TOOL_CALL_INPUT_MISSING_RE.test(raw) || TOOL_CALL_INPUT_PATH_RE.test(raw);
}
function isBillingAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isBillingErrorMessage(msg.errorMessage ?? "");
}
function isAuthPermanentErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.authPermanent);
}
function isAuthErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.auth);
}
function isOverloadedErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.overloaded);
}
function isJsonApiInternalServerError(raw) {
	if (!raw) return false;
	const value = raw.toLowerCase();
	return value.includes("\"type\":\"api_error\"") && value.includes("internal server error");
}
function parseImageDimensionError(raw) {
	if (!raw) return null;
	if (!raw.toLowerCase().includes("image dimensions exceed max allowed size")) return null;
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
	const lower = raw.toLowerCase();
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
	return !isImageDimensionErrorMessage(raw) && matchesErrorPatterns(raw, ERROR_PATTERNS.format);
}
function isAuthAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isAuthErrorMessage(msg.errorMessage ?? "");
}
function isModelNotFoundErrorMessage(raw) {
	if (!raw) return false;
	const lower = raw.toLowerCase();
	if (lower.includes("unknown model") || lower.includes("model not found") || lower.includes("model_not_found") || lower.includes("not_found_error") || lower.includes("does not exist") && lower.includes("model") || lower.includes("invalid model") && !lower.includes("invalid model reference")) return true;
	if (/models\/[^\s]+ is not found/i.test(raw)) return true;
	if (/\b404\b/.test(raw) && /not[-_ ]?found/i.test(raw)) return true;
	return false;
}
function classifyFailoverReason(raw) {
	if (isImageDimensionErrorMessage(raw)) return null;
	if (isImageSizeError(raw)) return null;
	if (isModelNotFoundErrorMessage(raw)) return "model_not_found";
	if (isTransientHttpError(raw)) return "timeout";
	if (isJsonApiInternalServerError(raw)) return "timeout";
	if (isRateLimitErrorMessage(raw)) return "rate_limit";
	if (isOverloadedErrorMessage(raw)) return "rate_limit";
	if (isCloudCodeAssistFormatError(raw)) return "format";
	if (isBillingErrorMessage(raw)) return "billing";
	if (isTimeoutErrorMessage(raw)) return "timeout";
	if (isAuthPermanentErrorMessage(raw)) return "auth_permanent";
	if (isAuthErrorMessage(raw)) return "auth";
	return null;
}
function isFailoverErrorMessage(raw) {
	return classifyFailoverReason(raw) !== null;
}
function isFailoverAssistantError(msg) {
	if (!msg || msg.stopReason !== "error") return false;
	return isFailoverErrorMessage(msg.errorMessage ?? "");
}

//#endregion
//#region src/agents/pi-embedded-helpers/google.ts
function isGoogleModelApi(api) {
	return api === "google-gemini-cli" || api === "google-generative-ai";
}

//#endregion
//#region src/agents/pi-embedded-helpers/openai.ts
function parseOpenAIReasoningSignature(value) {
	if (!value) return null;
	let candidate = null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
		try {
			candidate = JSON.parse(trimmed);
		} catch {
			return null;
		}
	} else if (typeof value === "object") candidate = value;
	if (!candidate) return null;
	const id = typeof candidate.id === "string" ? candidate.id : "";
	const type = typeof candidate.type === "string" ? candidate.type : "";
	if (!id.startsWith("rs_")) return null;
	if (type === "reasoning" || type.startsWith("reasoning.")) return {
		id,
		type
	};
	return null;
}
function hasFollowingNonThinkingBlock(content, index) {
	for (let i = index + 1; i < content.length; i++) {
		const block = content[i];
		if (!block || typeof block !== "object") return true;
		if (block.type !== "thinking") return true;
	}
	return false;
}
/**
* OpenAI Responses API can reject transcripts that contain a standalone `reasoning` item id
* without the required following item.
*
* OpenClaw persists provider-specific reasoning metadata in `thinkingSignature`; if that metadata
* is incomplete, drop the block to keep history usable.
*/
function downgradeOpenAIReasoningBlocks(messages) {
	const out = [];
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") {
			out.push(msg);
			continue;
		}
		if (msg.role !== "assistant") {
			out.push(msg);
			continue;
		}
		const assistantMsg = msg;
		if (!Array.isArray(assistantMsg.content)) {
			out.push(msg);
			continue;
		}
		let changed = false;
		const nextContent = [];
		for (let i = 0; i < assistantMsg.content.length; i++) {
			const block = assistantMsg.content[i];
			if (!block || typeof block !== "object") {
				nextContent.push(block);
				continue;
			}
			const record = block;
			if (record.type !== "thinking") {
				nextContent.push(block);
				continue;
			}
			if (!parseOpenAIReasoningSignature(record.thinkingSignature)) {
				nextContent.push(block);
				continue;
			}
			if (hasFollowingNonThinkingBlock(assistantMsg.content, i)) {
				nextContent.push(block);
				continue;
			}
			changed = true;
		}
		if (!changed) {
			out.push(msg);
			continue;
		}
		if (nextContent.length === 0) continue;
		out.push({
			...assistantMsg,
			content: nextContent
		});
	}
	return out;
}

//#endregion
//#region src/agents/tool-call-id.ts
const STRICT9_LEN = 9;
const TOOL_CALL_TYPES = new Set([
	"toolCall",
	"toolUse",
	"functionCall"
]);
/**
* Sanitize a tool call ID to be compatible with various providers.
*
* - "strict" mode: only [a-zA-Z0-9]
* - "strict9" mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
*/
function sanitizeToolCallId(id, mode = "strict") {
	if (!id || typeof id !== "string") {
		if (mode === "strict9") return "defaultid";
		return "defaulttoolid";
	}
	if (mode === "strict9") {
		const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
		if (alphanumericOnly.length >= STRICT9_LEN) return alphanumericOnly.slice(0, STRICT9_LEN);
		if (alphanumericOnly.length > 0) return shortHash(alphanumericOnly, STRICT9_LEN);
		return shortHash("sanitized", STRICT9_LEN);
	}
	const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
	return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}
function extractToolCallsFromAssistant(msg) {
	const content = msg.content;
	if (!Array.isArray(content)) return [];
	const toolCalls = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const rec = block;
		if (typeof rec.id !== "string" || !rec.id) continue;
		if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) toolCalls.push({
			id: rec.id,
			name: typeof rec.name === "string" ? rec.name : void 0
		});
	}
	return toolCalls;
}
function extractToolResultId(msg) {
	const toolCallId = msg.toolCallId;
	if (typeof toolCallId === "string" && toolCallId) return toolCallId;
	const toolUseId = msg.toolUseId;
	if (typeof toolUseId === "string" && toolUseId) return toolUseId;
	return null;
}
function shortHash(text, length = 8) {
	return createHash("sha256").update(text).digest("hex").slice(0, length);
}
function makeUniqueToolId(params) {
	if (params.mode === "strict9") {
		const base = sanitizeToolCallId(params.id, params.mode);
		const candidate = base.length >= STRICT9_LEN ? base.slice(0, STRICT9_LEN) : "";
		if (candidate && !params.used.has(candidate)) return candidate;
		for (let i = 0; i < 1e3; i += 1) {
			const hashed = shortHash(`${params.id}:${i}`, STRICT9_LEN);
			if (!params.used.has(hashed)) return hashed;
		}
		return shortHash(`${params.id}:${Date.now()}`, STRICT9_LEN);
	}
	const MAX_LEN = 40;
	const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
	if (!params.used.has(base)) return base;
	const hash = shortHash(params.id);
	const separator = params.mode === "strict" ? "" : "_";
	const maxBaseLen = MAX_LEN - separator.length - hash.length;
	const candidate = `${base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base}${separator}${hash}`;
	if (!params.used.has(candidate)) return candidate;
	for (let i = 2; i < 1e3; i += 1) {
		const suffix = params.mode === "strict" ? `x${i}` : `_${i}`;
		const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
		if (!params.used.has(next)) return next;
	}
	const ts = params.mode === "strict" ? `t${Date.now()}` : `_${Date.now()}`;
	return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}
function rewriteAssistantToolCallIds(params) {
	const content = params.message.content;
	if (!Array.isArray(content)) return params.message;
	let changed = false;
	const next = content.map((block) => {
		if (!block || typeof block !== "object") return block;
		const rec = block;
		const type = rec.type;
		const id = rec.id;
		if (type !== "functionCall" && type !== "toolUse" && type !== "toolCall" || typeof id !== "string" || !id) return block;
		const nextId = params.resolve(id);
		if (nextId === id) return block;
		changed = true;
		return {
			...block,
			id: nextId
		};
	});
	if (!changed) return params.message;
	return {
		...params.message,
		content: next
	};
}
function rewriteToolResultIds(params) {
	const toolCallId = typeof params.message.toolCallId === "string" && params.message.toolCallId ? params.message.toolCallId : void 0;
	const toolUseId = params.message.toolUseId;
	const toolUseIdStr = typeof toolUseId === "string" && toolUseId ? toolUseId : void 0;
	const nextToolCallId = toolCallId ? params.resolve(toolCallId) : void 0;
	const nextToolUseId = toolUseIdStr ? params.resolve(toolUseIdStr) : void 0;
	if (nextToolCallId === toolCallId && nextToolUseId === toolUseIdStr) return params.message;
	return {
		...params.message,
		...nextToolCallId && { toolCallId: nextToolCallId },
		...nextToolUseId && { toolUseId: nextToolUseId }
	};
}
/**
* Sanitize tool call IDs for provider compatibility.
*
* @param messages - The messages to sanitize
* @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
*/
function sanitizeToolCallIdsForCloudCodeAssist(messages, mode = "strict") {
	const map = /* @__PURE__ */ new Map();
	const used = /* @__PURE__ */ new Set();
	const resolve = (id) => {
		const existing = map.get(id);
		if (existing) return existing;
		const next = makeUniqueToolId({
			id,
			used,
			mode
		});
		map.set(id, next);
		used.add(next);
		return next;
	};
	let changed = false;
	const out = messages.map((msg) => {
		if (!msg || typeof msg !== "object") return msg;
		const role = msg.role;
		if (role === "assistant") {
			const next = rewriteAssistantToolCallIds({
				message: msg,
				resolve
			});
			if (next !== msg) changed = true;
			return next;
		}
		if (role === "toolResult") {
			const next = rewriteToolResultIds({
				message: msg,
				resolve
			});
			if (next !== msg) changed = true;
			return next;
		}
		return msg;
	});
	return changed ? out : messages;
}

//#endregion
//#region src/agents/pi-embedded-helpers/images.ts
async function sanitizeSessionMessagesImages(messages, label, options) {
	const allowNonImageSanitization = (options?.sanitizeMode ?? "full") === "full";
	const imageSanitization = {
		maxDimensionPx: options?.maxDimensionPx,
		maxBytes: options?.maxBytes
	};
	const sanitizedIds = allowNonImageSanitization && options?.sanitizeToolCallIds ? sanitizeToolCallIdsForCloudCodeAssist(messages, options.toolCallIdMode) : messages;
	const out = [];
	for (const msg of sanitizedIds) {
		if (!msg || typeof msg !== "object") {
			out.push(msg);
			continue;
		}
		const role = msg.role;
		if (role === "toolResult") {
			const toolMsg = msg;
			const nextContent = await sanitizeContentBlocksImages(Array.isArray(toolMsg.content) ? toolMsg.content : [], label, imageSanitization);
			out.push({
				...toolMsg,
				content: nextContent
			});
			continue;
		}
		if (role === "user") {
			const userMsg = msg;
			const content = userMsg.content;
			if (Array.isArray(content)) {
				const nextContent = await sanitizeContentBlocksImages(content, label, imageSanitization);
				out.push({
					...userMsg,
					content: nextContent
				});
				continue;
			}
		}
		if (role === "assistant") {
			const assistantMsg = msg;
			if (assistantMsg.stopReason === "error") {
				const content = assistantMsg.content;
				if (Array.isArray(content)) {
					const nextContent = await sanitizeContentBlocksImages(content, label, imageSanitization);
					out.push({
						...assistantMsg,
						content: nextContent
					});
				} else out.push(assistantMsg);
				continue;
			}
			const content = assistantMsg.content;
			if (Array.isArray(content)) {
				if (!allowNonImageSanitization) {
					const nextContent = await sanitizeContentBlocksImages(content, label, imageSanitization);
					out.push({
						...assistantMsg,
						content: nextContent
					});
					continue;
				}
				const finalContent = await sanitizeContentBlocksImages((options?.preserveSignatures ? content : stripThoughtSignatures(content, options?.sanitizeThoughtSignatures)).filter((block) => {
					if (!block || typeof block !== "object") return true;
					const rec = block;
					if (rec.type !== "text" || typeof rec.text !== "string") return true;
					return rec.text.trim().length > 0;
				}), label, imageSanitization);
				if (finalContent.length === 0) continue;
				out.push({
					...assistantMsg,
					content: finalContent
				});
				continue;
			}
		}
		out.push(msg);
	}
	return out;
}

//#endregion
//#region src/agents/pi-embedded-helpers/messaging-dedupe.ts
const MIN_DUPLICATE_TEXT_LENGTH = 10;
/**
* Normalize text for duplicate comparison.
* - Trims whitespace
* - Lowercases
* - Strips emoji (Emoji_Presentation and Extended_Pictographic)
* - Collapses multiple spaces to single space
*/
function normalizeTextForComparison(text) {
	return text.trim().toLowerCase().replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
}
function isMessagingToolDuplicateNormalized(normalized, normalizedSentTexts) {
	if (normalizedSentTexts.length === 0) return false;
	if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
	return normalizedSentTexts.some((normalizedSent) => {
		if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
		return normalized.includes(normalizedSent) || normalizedSent.includes(normalized);
	});
}
function isMessagingToolDuplicate(text, sentTexts) {
	if (sentTexts.length === 0) return false;
	const normalized = normalizeTextForComparison(text);
	if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) return false;
	return isMessagingToolDuplicateNormalized(normalized, sentTexts.map(normalizeTextForComparison));
}

//#endregion
//#region src/agents/pi-embedded-helpers/thinking.ts
function extractSupportedValues(raw) {
	const match = raw.match(/supported values are:\s*([^\n.]+)/i) ?? raw.match(/supported values:\s*([^\n.]+)/i);
	if (!match?.[1]) return [];
	const fragment = match[1];
	const quoted = Array.from(fragment.matchAll(/['"]([^'"]+)['"]/g)).map((entry) => entry[1]?.trim());
	if (quoted.length > 0) return quoted.filter((entry) => Boolean(entry));
	return fragment.split(/,|\band\b/gi).map((entry) => entry.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, "").trim()).filter(Boolean);
}
function pickFallbackThinkingLevel(params) {
	const raw = params.message?.trim();
	if (!raw) return;
	const supported = extractSupportedValues(raw);
	if (supported.length === 0) return;
	for (const entry of supported) {
		const normalized = normalizeThinkLevel(entry);
		if (!normalized) continue;
		if (params.attempted.has(normalized)) continue;
		return normalized;
	}
}

//#endregion
//#region src/agents/pi-embedded-helpers/turns.ts
function validateTurnsWithConsecutiveMerge(params) {
	const { messages, role, merge } = params;
	if (!Array.isArray(messages) || messages.length === 0) return messages;
	const result = [];
	let lastRole;
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") {
			result.push(msg);
			continue;
		}
		const msgRole = msg.role;
		if (!msgRole) {
			result.push(msg);
			continue;
		}
		if (msgRole === lastRole && lastRole === role) {
			const lastMsg = result[result.length - 1];
			const currentMsg = msg;
			if (lastMsg && typeof lastMsg === "object") {
				const lastTyped = lastMsg;
				result[result.length - 1] = merge(lastTyped, currentMsg);
				continue;
			}
		}
		result.push(msg);
		lastRole = msgRole;
	}
	return result;
}
function mergeConsecutiveAssistantTurns(previous, current) {
	const mergedContent = [...Array.isArray(previous.content) ? previous.content : [], ...Array.isArray(current.content) ? current.content : []];
	return {
		...previous,
		content: mergedContent,
		...current.usage && { usage: current.usage },
		...current.stopReason && { stopReason: current.stopReason },
		...current.errorMessage && { errorMessage: current.errorMessage }
	};
}
/**
* Validates and fixes conversation turn sequences for Gemini API.
* Gemini requires strict alternating user→assistant→tool→user pattern.
* Merges consecutive assistant messages together.
*/
function validateGeminiTurns(messages) {
	return validateTurnsWithConsecutiveMerge({
		messages,
		role: "assistant",
		merge: mergeConsecutiveAssistantTurns
	});
}
function mergeConsecutiveUserTurns(previous, current) {
	const mergedContent = [...Array.isArray(previous.content) ? previous.content : [], ...Array.isArray(current.content) ? current.content : []];
	return {
		...current,
		content: mergedContent,
		timestamp: current.timestamp ?? previous.timestamp
	};
}
/**
* Validates and fixes conversation turn sequences for Anthropic API.
* Anthropic requires strict alternating user→assistant pattern.
* Merges consecutive user messages together.
*/
function validateAnthropicTurns(messages) {
	return validateTurnsWithConsecutiveMerge({
		messages,
		role: "user",
		merge: mergeConsecutiveUserTurns
	});
}

//#endregion
export { isTimeoutErrorMessage as A, isCompactionFailureError as C, isLikelyContextOverflowError as D, isFailoverErrorMessage as E, buildBootstrapContextFiles as F, ensureSessionHeader as I, resolveBootstrapMaxChars as L, parseImageDimensionError as M, parseImageSizeError as N, isRateLimitAssistantError as O, sanitizeUserFacingText as P, resolveBootstrapTotalMaxChars as R, isCloudCodeAssistFormatError as S, isFailoverAssistantError as T, formatRawAssistantErrorForUi as _, isMessagingToolDuplicateNormalized as a, isAuthPermanentErrorMessage as b, extractToolCallsFromAssistant as c, downgradeOpenAIReasoningBlocks as d, isGoogleModelApi as f, formatBillingErrorMessage as g, formatAssistantErrorText as h, isMessagingToolDuplicate as i, isTransientHttpError as j, isRawApiErrorPayload as k, extractToolResultId as l, classifyFailoverReason as m, validateGeminiTurns as n, normalizeTextForComparison as o, BILLING_ERROR_USER_MESSAGE as p, pickFallbackThinkingLevel as r, sanitizeSessionMessagesImages as s, validateAnthropicTurns as t, sanitizeToolCallIdsForCloudCodeAssist as u, getApiErrorPayloadFingerprint as v, isContextOverflowError as w, isBillingAssistantError as x, isAuthAssistantError as y, sanitizeGoogleTurnOrdering as z };