import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/agents/pi-embedded-helpers/failover-matches.ts
const PERIODIC_USAGE_LIMIT_RE = /\b(?:daily|weekly|monthly)(?:\/(?:daily|weekly|monthly))* (?:usage )?limit(?:s)?(?: (?:exhausted|reached|exceeded))?\b/i;
const HIGH_CONFIDENCE_AUTH_PERMANENT_PATTERNS = [
	/api[_ ]?key[_ ]?(?:revoked|deactivated|deleted)/i,
	"key has been disabled",
	"key has been revoked",
	"account has been deactivated",
	"not allowed for this organization"
];
const AMBIGUOUS_AUTH_ERROR_PATTERNS = [
	/invalid[_ ]?api[_ ]?key/,
	/could not (?:authenticate|validate).*(?:api[_ ]?key|credentials)/i,
	"permission_error"
];
const COMMON_AUTH_ERROR_PATTERNS = [
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
	"no api key found",
	/\bfailed to (?:extract|parse|validate|decode)\b.*\btoken\b/
];
const CJK_AUTH_ERROR_PATTERNS = [
	"无权访问",
	"认证失败",
	"鉴权失败",
	"密钥无效",
	"apikey 无效"
];
const ZAI_BILLING_CODE_1311_RE = /"code"\s*:\s*1311\b/;
const ZAI_AUTH_CODE_1113_RE = /"code"\s*:\s*1113\b/;
const STATUS_INTERNAL_SERVER_ERROR_RE = /\bstatus:\s*internal server error\b/i;
const STATUS_INTERNAL_SERVER_ERROR_WITH_500_RE = /^(?=[\s\S]*\bstatus:\s*internal server error\b)(?=[\s\S]*\bcode["']?\s*[:=]\s*500\b)/i;
const HTTP_5XX_STATUS_RE = /\bHTTP\s+5\d\d\b/i;
const ZAI_AUTH_ERROR_PATTERNS = [ZAI_AUTH_CODE_1113_RE];
const ERROR_PATTERNS = {
	rateLimit: [
		/rate[_ ]limit|too many requests|429/,
		/too many (?:concurrent )?requests/i,
		/throttling(?:exception)?/i,
		"model_cooldown",
		"exceeded your current quota",
		"resource has been exhausted",
		"quota exceeded",
		"resource_exhausted",
		"throttlingexception",
		"throttling_exception",
		"throttled",
		"throttling",
		"usage limit",
		/\btpm\b/i,
		"tokens per minute",
		"tokens per day",
		"请求过于频繁",
		"调用频率",
		"频率限制",
		"配额不足",
		"配额已用尽",
		"额度不足",
		"额度已用尽"
	],
	overloaded: [
		/overloaded_error|"type"\s*:\s*"overloaded_error"/i,
		"overloaded",
		/\b(?:selected\s+)?model\s+(?:is\s+)?at capacity\b/i,
		/service[_ ]unavailable.*(?:overload|capacity|high[_ ]demand)|(?:overload|capacity|high[_ ]demand).*service[_ ]unavailable/i,
		"high demand",
		"high load",
		"服务过载",
		"当前负载过高"
	],
	serverError: [
		"an error occurred while processing",
		"internal server error",
		"internal_error",
		"server_error",
		"service temporarily unavailable",
		"service_unavailable",
		"bad gateway",
		"gateway timeout",
		"upstream error",
		"upstream connect error",
		"connection reset",
		"内部错误",
		"服务器错误",
		"服务器内部错误",
		"系统错误",
		"系统繁忙",
		"系统异常"
	],
	timeout: [
		"timeout",
		"timed out",
		"service unavailable",
		"deadline exceeded",
		"context deadline exceeded",
		/^(?=[\s\S]*\bgot status:\s*internal\b)(?=[\s\S]*\bcode["']?\s*[:=]\s*500\b)/i,
		/^(?=[\s\S]*["']status["']\s*:\s*["']internal["'])(?=[\s\S]*["']code["']\s*:\s*500\b)/i,
		"connection error",
		"network error",
		"network request failed",
		"fetch failed",
		"socket hang up",
		"网络错误",
		"网络异常",
		"服务暂时不可用",
		"服务繁忙",
		"请求超时",
		"连接超时",
		"连接错误",
		/\beconn(?:refused|reset|aborted)\b/i,
		/\benetunreach\b/i,
		/\behostunreach\b/i,
		/\behostdown\b/i,
		/\benetreset\b/i,
		/\betimedout\b/i,
		/\besockettimedout\b/i,
		/\bepipe\b/i,
		/\benotfound\b/i,
		/\beai_again\b/i,
		/without sending (?:any )?chunks?/i,
		/\bstop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
		/\breason:\s*(?:abort|error|malformed_response|network_error)\b/i,
		/\bunhandled stop reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
		/\bfinish_reason:\s*(?:abort|error|malformed_response|network_error)\b/i,
		/\boperation was aborted\b/i,
		/\bstream (?:was )?(?:closed|aborted)\b/i,
		/^terminated$/i,
		/\bund_err_(?:socket|connect|headers?|body|req_content_length_mismatch|aborted|closed)\b/i,
		/^request failed$/i,
		/\brequest failed after repeated internal retries\b/i
	],
	billing: [
		/["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|\b(?:got|returned|received)\s+(?:a\s+)?402\b|^\s*402\s+payment/i,
		"payment required",
		"insufficient credits",
		/used\s+all\s+available\s+credits/i,
		/(?:monthly\s+)?spend(?:ing)?\s+limit/i,
		/insufficient[_ ]quota/i,
		"credit balance",
		"plans & billing",
		/insufficient[_ ]balance/i,
		/\binsufficient\s+\w+\s+balance\b/i,
		"insufficient usd or diem balance",
		/requires?\s+more\s+credits/i,
		/out of extra usage/i,
		/draw from your extra usage/i,
		/extra usage is required(?: for long context requests)?/i,
		"余额不足",
		"账户余额不足",
		"欠费",
		"账户已欠费",
		ZAI_BILLING_CODE_1311_RE
	],
	authPermanent: HIGH_CONFIDENCE_AUTH_PERMANENT_PATTERNS,
	auth: [
		...AMBIGUOUS_AUTH_ERROR_PATTERNS,
		...COMMON_AUTH_ERROR_PATTERNS,
		...ZAI_AUTH_ERROR_PATTERNS,
		...CJK_AUTH_ERROR_PATTERNS
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
const BILLING_ERROR_HEAD_RE = /^(?:error[:\s-]+)?billing(?:\s+error)?(?:[:\s-]+|$)|^(?:error[:\s-]+)?(?:credit balance|insufficient credits?|payment required|http\s*402\b)/i;
const BILLING_ERROR_HARD_402_RE = /["']?(?:status|code)["']?\s*[:=]\s*402\b|\bhttp\s*402\b|\berror(?:\s+code)?\s*[:=]?\s*402\b|^\s*402\s+payment/i;
const BILLING_ERROR_MAX_LENGTH = 512;
function matchesErrorPatterns(raw, patterns) {
	if (!raw) return false;
	const value = normalizeLowercaseStringOrEmpty(raw);
	return patterns.some((pattern) => pattern instanceof RegExp ? pattern.test(value) : value.includes(pattern));
}
function matchesErrorPatternGroups(raw, groups) {
	return groups.some((patterns) => matchesErrorPatterns(raw, patterns));
}
function matchesFormatErrorPattern(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.format);
}
function isRateLimitErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.rateLimit);
}
function isTimeoutErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.timeout);
}
function isPeriodicUsageLimitErrorMessage(raw) {
	return PERIODIC_USAGE_LIMIT_RE.test(raw);
}
function isBillingErrorMessage(raw) {
	const value = normalizeLowercaseStringOrEmpty(raw);
	if (!value) return false;
	if (raw.length > BILLING_ERROR_MAX_LENGTH) return BILLING_ERROR_HARD_402_RE.test(value) || ZAI_BILLING_CODE_1311_RE.test(value);
	if (matchesErrorPatterns(value, ERROR_PATTERNS.billing)) return true;
	if (!BILLING_ERROR_HEAD_RE.test(raw)) return false;
	return value.includes("upgrade") || value.includes("credits") || value.includes("payment") || value.includes("purchase") || value.includes("subscription") || value.includes("plan");
}
function isAuthPermanentErrorMessage(raw) {
	return matchesErrorPatternGroups(raw, [HIGH_CONFIDENCE_AUTH_PERMANENT_PATTERNS]);
}
function isAuthErrorMessage(raw) {
	return matchesErrorPatternGroups(raw, [
		AMBIGUOUS_AUTH_ERROR_PATTERNS,
		COMMON_AUTH_ERROR_PATTERNS,
		ZAI_AUTH_ERROR_PATTERNS,
		CJK_AUTH_ERROR_PATTERNS
	]);
}
function isOverloadedErrorMessage(raw) {
	return matchesErrorPatterns(raw, ERROR_PATTERNS.overloaded);
}
function isServerErrorMessage(raw) {
	const value = normalizeLowercaseStringOrEmpty(raw);
	if (!value) return false;
	if (STATUS_INTERNAL_SERVER_ERROR_WITH_500_RE.test(value) || HTTP_5XX_STATUS_RE.test(value)) return true;
	const scrubbed = value.replace(STATUS_INTERNAL_SERVER_ERROR_RE, "").trim();
	if (scrubbed === "") return true;
	return matchesErrorPatterns(scrubbed, ERROR_PATTERNS.serverError);
}
//#endregion
export { isPeriodicUsageLimitErrorMessage as a, isTimeoutErrorMessage as c, isOverloadedErrorMessage as i, matchesFormatErrorPattern as l, isAuthPermanentErrorMessage as n, isRateLimitErrorMessage as o, isBillingErrorMessage as r, isServerErrorMessage as s, isAuthErrorMessage as t };
