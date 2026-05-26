import { n as getCommandPathWithRootOptions } from "./argv-j42r4Rb7.js";
import { s as resolveConfigPath } from "./paths-Cw7f9XhU.js";
import fs from "node:fs";
import JSON5 from "json5";
//#region src/security/safe-regex.ts
const SAFE_REGEX_CACHE_MAX = 256;
const SAFE_REGEX_TEST_WINDOW = 2048;
const safeRegexCache = /* @__PURE__ */ new Map();
function createParseFrame() {
	return {
		lastToken: null,
		containsRepetition: false,
		hasAlternation: false,
		branchMinLength: 0,
		branchMaxLength: 0,
		altMinLength: null,
		altMaxLength: null
	};
}
function addLength(left, right) {
	if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
	return left + right;
}
function multiplyLength(length, factor) {
	if (!Number.isFinite(length)) return factor === 0 ? 0 : Number.POSITIVE_INFINITY;
	return length * factor;
}
function recordAlternative(frame) {
	if (frame.altMinLength === null || frame.altMaxLength === null) {
		frame.altMinLength = frame.branchMinLength;
		frame.altMaxLength = frame.branchMaxLength;
		return;
	}
	frame.altMinLength = Math.min(frame.altMinLength, frame.branchMinLength);
	frame.altMaxLength = Math.max(frame.altMaxLength, frame.branchMaxLength);
}
function readQuantifier(source, index) {
	const ch = source[index];
	const consumed = source[index + 1] === "?" ? 2 : 1;
	if (ch === "*") return {
		consumed,
		minRepeat: 0,
		maxRepeat: null
	};
	if (ch === "+") return {
		consumed,
		minRepeat: 1,
		maxRepeat: null
	};
	if (ch === "?") return {
		consumed,
		minRepeat: 0,
		maxRepeat: 1
	};
	if (ch !== "{") return null;
	let i = index + 1;
	while (i < source.length && /\d/.test(source[i])) i += 1;
	if (i === index + 1) return null;
	const minRepeat = Number.parseInt(source.slice(index + 1, i), 10);
	let maxRepeat = minRepeat;
	if (source[i] === ",") {
		i += 1;
		const maxStart = i;
		while (i < source.length && /\d/.test(source[i])) i += 1;
		maxRepeat = i === maxStart ? null : Number.parseInt(source.slice(maxStart, i), 10);
	}
	if (source[i] !== "}") return null;
	i += 1;
	if (source[i] === "?") i += 1;
	if (maxRepeat !== null && maxRepeat < minRepeat) return null;
	return {
		consumed: i - index,
		minRepeat,
		maxRepeat
	};
}
function tokenizePattern(source) {
	const tokens = [];
	let inCharClass = false;
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (inCharClass) {
			if (ch === "\\") {
				i += 1;
				continue;
			}
			if (ch === "]") inCharClass = false;
			continue;
		}
		if (ch === "\\") {
			i += 1;
			tokens.push({ kind: "simple-token" });
			continue;
		}
		if (ch === "[") {
			inCharClass = true;
			tokens.push({ kind: "simple-token" });
			continue;
		}
		if (ch === "(") {
			tokens.push({ kind: "group-open" });
			continue;
		}
		if (ch === ")") {
			tokens.push({ kind: "group-close" });
			continue;
		}
		if (ch === "|") {
			tokens.push({ kind: "alternation" });
			continue;
		}
		const quantifier = readQuantifier(source, i);
		if (quantifier) {
			tokens.push({
				kind: "quantifier",
				quantifier
			});
			i += quantifier.consumed - 1;
			continue;
		}
		tokens.push({ kind: "simple-token" });
	}
	return tokens;
}
function analyzeTokensForNestedRepetition(tokens) {
	const frames = [createParseFrame()];
	const emitToken = (token) => {
		const frame = frames[frames.length - 1];
		frame.lastToken = token;
		if (token.containsRepetition) frame.containsRepetition = true;
		frame.branchMinLength = addLength(frame.branchMinLength, token.minLength);
		frame.branchMaxLength = addLength(frame.branchMaxLength, token.maxLength);
	};
	const emitSimpleToken = () => {
		emitToken({
			containsRepetition: false,
			hasAmbiguousAlternation: false,
			minLength: 1,
			maxLength: 1
		});
	};
	for (const token of tokens) {
		if (token.kind === "simple-token") {
			emitSimpleToken();
			continue;
		}
		if (token.kind === "group-open") {
			frames.push(createParseFrame());
			continue;
		}
		if (token.kind === "group-close") {
			if (frames.length > 1) {
				const frame = frames.pop();
				if (frame.hasAlternation) recordAlternative(frame);
				const groupMinLength = frame.hasAlternation ? frame.altMinLength ?? 0 : frame.branchMinLength;
				const groupMaxLength = frame.hasAlternation ? frame.altMaxLength ?? 0 : frame.branchMaxLength;
				emitToken({
					containsRepetition: frame.containsRepetition,
					hasAmbiguousAlternation: frame.hasAlternation && frame.altMinLength !== null && frame.altMaxLength !== null && frame.altMinLength !== frame.altMaxLength,
					minLength: groupMinLength,
					maxLength: groupMaxLength
				});
			}
			continue;
		}
		if (token.kind === "alternation") {
			const frame = frames[frames.length - 1];
			frame.hasAlternation = true;
			recordAlternative(frame);
			frame.branchMinLength = 0;
			frame.branchMaxLength = 0;
			frame.lastToken = null;
			continue;
		}
		const frame = frames[frames.length - 1];
		const previousToken = frame.lastToken;
		if (!previousToken) continue;
		if (previousToken.containsRepetition) return true;
		if (previousToken.hasAmbiguousAlternation && token.quantifier.maxRepeat === null) return true;
		const previousMinLength = previousToken.minLength;
		const previousMaxLength = previousToken.maxLength;
		previousToken.minLength = multiplyLength(previousToken.minLength, token.quantifier.minRepeat);
		previousToken.maxLength = token.quantifier.maxRepeat === null ? Number.POSITIVE_INFINITY : multiplyLength(previousToken.maxLength, token.quantifier.maxRepeat);
		previousToken.containsRepetition = true;
		frame.containsRepetition = true;
		frame.branchMinLength = frame.branchMinLength - previousMinLength + previousToken.minLength;
		frame.branchMaxLength = addLength(Number.isFinite(frame.branchMaxLength) && Number.isFinite(previousMaxLength) ? frame.branchMaxLength - previousMaxLength : Number.POSITIVE_INFINITY, previousToken.maxLength);
	}
	return false;
}
function testRegexFromStart(regex, value) {
	regex.lastIndex = 0;
	return regex.test(value);
}
function testRegexWithBoundedInput(regex, input, maxWindow = SAFE_REGEX_TEST_WINDOW) {
	if (maxWindow <= 0) return false;
	if (input.length <= maxWindow) return testRegexFromStart(regex, input);
	if (testRegexFromStart(regex, input.slice(0, maxWindow))) return true;
	return testRegexFromStart(regex, input.slice(-maxWindow));
}
function hasNestedRepetition(source) {
	return analyzeTokensForNestedRepetition(tokenizePattern(source));
}
function compileSafeRegexDetailed(source, flags = "") {
	const trimmed = source.trim();
	if (!trimmed) return {
		regex: null,
		source: trimmed,
		flags,
		reason: "empty"
	};
	const cacheKey = `${flags}::${trimmed}`;
	if (safeRegexCache.has(cacheKey)) return safeRegexCache.get(cacheKey) ?? {
		regex: null,
		source: trimmed,
		flags,
		reason: "invalid-regex"
	};
	let result;
	if (hasNestedRepetition(trimmed)) result = {
		regex: null,
		source: trimmed,
		flags,
		reason: "unsafe-nested-repetition"
	};
	else try {
		result = {
			regex: new RegExp(trimmed, flags),
			source: trimmed,
			flags,
			reason: null
		};
	} catch {
		result = {
			regex: null,
			source: trimmed,
			flags,
			reason: "invalid-regex"
		};
	}
	safeRegexCache.set(cacheKey, result);
	if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
		const oldestKey = safeRegexCache.keys().next().value;
		if (oldestKey) safeRegexCache.delete(oldestKey);
	}
	return result;
}
function compileSafeRegex(source, flags = "") {
	return compileSafeRegexDetailed(source, flags).regex;
}
//#endregion
//#region src/security/config-regex.ts
function normalizeRejectReason(result) {
	if (result.reason === null || result.reason === "empty") return null;
	return result.reason;
}
function compileConfigRegex(pattern, flags = "") {
	const result = compileSafeRegexDetailed(pattern, flags);
	if (result.reason === "empty") return null;
	return {
		regex: result.regex,
		pattern: result.source,
		flags: result.flags,
		reason: normalizeRejectReason(result)
	};
}
function compileConfigRegexes(patterns, flags = "") {
	const regexes = [];
	const rejected = [];
	for (const pattern of patterns) {
		const compiled = compileConfigRegex(pattern, flags);
		if (!compiled) continue;
		if (compiled.regex) {
			regexes.push(compiled.regex);
			continue;
		}
		rejected.push({
			pattern: compiled.pattern,
			flags: compiled.flags,
			reason: compiled.reason
		});
	}
	return {
		regexes,
		rejected
	};
}
//#endregion
//#region src/logging/config.ts
let cachedLoggingConfig;
function shouldSkipMutatingLoggingConfigRead(argv = process.argv) {
	const [primary, secondary] = getCommandPathWithRootOptions(argv, 2);
	return primary === "config" && (secondary === "schema" || secondary === "validate");
}
function isObjectRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readLoggingConfig() {
	if (shouldSkipMutatingLoggingConfigRead()) return;
	try {
		const configPath = resolveConfigPath();
		if (cachedLoggingConfig?.path === configPath) return cachedLoggingConfig.logging;
		if (!fs.existsSync(configPath)) return;
		const parsed = JSON5.parse(fs.readFileSync(configPath, "utf8"));
		const logging = isObjectRecord(parsed) ? parsed.logging : void 0;
		const resolved = isObjectRecord(logging) ? logging : void 0;
		cachedLoggingConfig = {
			path: configPath,
			logging: resolved
		};
		return resolved;
	} catch {
		return;
	}
}
//#endregion
//#region src/logging/redact-bounded.ts
const REDACT_REGEX_CHUNK_THRESHOLD = 32768;
const REDACT_REGEX_CHUNK_SIZE = 16384;
function replacePatternBounded(text, pattern, replacer, options) {
	const chunkThreshold = options?.chunkThreshold ?? REDACT_REGEX_CHUNK_THRESHOLD;
	const chunkSize = options?.chunkSize ?? REDACT_REGEX_CHUNK_SIZE;
	if (chunkThreshold <= 0 || chunkSize <= 0 || text.length <= chunkThreshold) return text.replace(pattern, replacer);
	let output = "";
	for (let index = 0; index < text.length; index += chunkSize) output += text.slice(index, index + chunkSize).replace(pattern, replacer);
	return output;
}
//#endregion
//#region src/logging/redact.ts
const DEFAULT_REDACT_MODE = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const PAYMENT_CREDENTIAL_ENV_KEYS = String.raw`CARD[_-]?NUMBER|CARD[_-]?CVC|CARD[_-]?CVV|CVC|CVV|SECURITY[_-]?CODE|PAYMENT[_-]?CREDENTIAL|SHARED[_-]?PAYMENT[_-]?TOKEN`;
const PAYMENT_CREDENTIAL_QUERY_KEYS = String.raw`card[-_]?number|card[-_]?cvc|card[-_]?cvv|cvc|cvv|security[-_]?code|payment[-_]?credential|shared[-_]?payment[-_]?token`;
const PAYMENT_CREDENTIAL_JSON_KEYS = String.raw`cardNumber|card_number|cardCvc|card_cvc|cardCvv|card_cvv|cvc|cvv|securityCode|security_code|paymentCredential|payment_credential|sharedPaymentToken|shared_payment_token`;
const STRUCTURED_SECRET_FIELD_RE = new RegExp(String.raw`^(?:api[-_]?key|apiKey|token|secret|password|passwd|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|${PAYMENT_CREDENTIAL_QUERY_KEYS}|${PAYMENT_CREDENTIAL_JSON_KEYS})$`, "i");
const STRUCTURED_APP_PASSWORD_FIELD_RE = /^(?:apple|icloud|app[-_]?specific[-_]?password|appSpecificPassword|application[-_]?password|text|content|message|error|errorMessage|detail|details|reason)$/i;
const APP_SPECIFIC_PASSWORD_RE = /\b([a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4})\b/g;
const BENIGN_APP_PASSWORD_WORDS = new Set([
	"case",
	"claw",
	"demo",
	"file",
	"main",
	"name",
	"open",
	"path",
	"slug",
	"test"
]);
const STRUCTURED_SECRET_ENV_FIELD_RE = new RegExp(String.raw`^(?:(?:[A-Z0-9]+[_-])+(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)|API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})$`, "i");
const DEFAULT_REDACT_PATTERNS = [
	String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1/g`,
	String.raw`/\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|${PAYMENT_CREDENTIAL_ENV_KEYS})\b\s*[=:]\s*\\+(["'])([^\s"'\\]+)\\+\1/g`,
	String.raw`/[?&](?:access[-_]?token|auth[-_]?token|hook[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature|${PAYMENT_CREDENTIAL_QUERY_KEYS})=([^&\s"'<>]+)/gi`,
	String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken|${PAYMENT_CREDENTIAL_JSON_KEYS})"\s*:\s*"([^"]+)"`,
	String.raw`(^|[\s,{])["']?(?:api[-_]key|access[-_]token|refresh[-_]token|authToken|auth[-_]token|clientSecret|client[-_]secret|appSecret|app[-_]secret)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
	String.raw`(^|[\s,{])["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)["']?\s*[:=]\s*(["'])([^"'\r\n]+)\2`,
	String.raw`--(?:api[-_]?key|hook[-_]?token|token|secret|password|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS})\s+(["']?)([^\s"']+)\1`,
	String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
	String.raw`Authorization\s*[:=]\s*Basic\s+([A-Za-z0-9+/=]+)`,
	String.raw`(?:X-OpenClaw-Token|x-pomerium-jwt-assertion|X-Api-Key|X-Auth-Token)\s*[:=]\s*([^\s"',;]+)`,
	String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
	String.raw`(^|[\s,;])(?:access_token|refresh_token|auth[-_]?token|api[-_]?key|client[-_]?secret|app[-_]?secret|token|secret|password|passwd|${PAYMENT_CREDENTIAL_QUERY_KEYS})=([^\s&#]+)`,
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
	String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
	String.raw`(ghp_[A-Za-z0-9]{20,})`,
	String.raw`(github_pat_[A-Za-z0-9_]{20,})`,
	String.raw`(xox[baprs]-[A-Za-z0-9-]{10,})`,
	String.raw`(xapp-[A-Za-z0-9-]{10,})`,
	String.raw`(gsk_[A-Za-z0-9_-]{10,})`,
	String.raw`(AIza[0-9A-Za-z\-_]{20,})`,
	String.raw`(ya29\.[0-9A-Za-z_\-./+=]{10,})`,
	String.raw`(1//0[0-9A-Za-z_\-./+=]{10,})`,
	String.raw`(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})`,
	String.raw`(pplx-[A-Za-z0-9_-]{10,})`,
	String.raw`(npm_[A-Za-z0-9]{10,})`,
	String.raw`(AKID[A-Za-z0-9]{10,})`,
	String.raw`(LTAI[A-Za-z0-9]{10,})`,
	String.raw`(hf_[A-Za-z0-9]{10,})`,
	String.raw`(r8_[A-Za-z0-9]{10,})`,
	String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
	String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`
];
function normalizeMode(value) {
	return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}
function parsePattern(raw) {
	if (raw instanceof RegExp) {
		if (raw.flags.includes("g")) return raw;
		return new RegExp(raw.source, `${raw.flags}g`);
	}
	if (!raw.trim()) return null;
	const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
	if (match) {
		const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
		return compileConfigRegex(match[1], flags)?.regex ?? null;
	}
	return compileConfigRegex(raw, "gi")?.regex ?? null;
}
function resolvePatterns(value) {
	return (value?.length ? value : DEFAULT_REDACT_PATTERNS).map(parsePattern).filter((re) => Boolean(re));
}
function maskToken(token) {
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) return "***";
	return `${token.slice(0, DEFAULT_REDACT_KEEP_START)}…${token.slice(-4)}`;
}
function redactPemBlock(block) {
	const lines = block.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) return "***";
	return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}
function redactMatch(match, groups) {
	if (match.includes("PRIVATE KEY-----")) return redactPemBlock(match);
	const token = groups.findLast((value) => typeof value === "string" && value.length > 0) ?? match;
	const masked = maskToken(token);
	if (token === match) return masked;
	return match.replace(token, masked);
}
function redactText(text, patterns) {
	let next = text;
	for (const pattern of patterns) next = replacePatternBounded(next, pattern, (...args) => redactMatch(args[0], args.slice(1, -2)));
	return next;
}
function looksLikeAppSpecificPassword(candidate) {
	return candidate.split("-").every((part) => !BENIGN_APP_PASSWORD_WORDS.has(part.toLowerCase()));
}
function redactAppSpecificPasswords(text) {
	return replacePatternBounded(text, APP_SPECIFIC_PASSWORD_RE, (match, token) => looksLikeAppSpecificPassword(token) ? redactMatch(match, [token]) : match);
}
function resolveConfigRedaction() {
	const cfg = readLoggingConfig();
	return {
		mode: normalizeMode(cfg?.redactSensitive),
		patterns: cfg?.redactPatterns
	};
}
function resolveRedactOptions(options) {
	const resolved = options ?? resolveConfigRedaction();
	const mode = normalizeMode(resolved.mode);
	if (mode === "off") return {
		mode,
		patterns: []
	};
	return {
		mode,
		patterns: resolvePatterns(resolved.patterns)
	};
}
function redactSensitiveText(text, options) {
	if (!text) return text;
	const resolved = resolveRedactOptions(options);
	if (resolved.mode === "off") return text;
	if (!resolved.patterns.length) return text;
	return redactText(text, resolved.patterns);
}
function redactToolDetail(detail) {
	const resolved = resolveConfigRedaction();
	if (normalizeMode(resolved.mode) !== "tools") return detail;
	return redactSensitiveText(detail, resolved);
}
function resolveToolPayloadRedaction(loggingConfig = readLoggingConfig()) {
	const userPatterns = loggingConfig?.redactPatterns;
	return {
		mode: "tools",
		patterns: userPatterns && userPatterns.length > 0 ? [...userPatterns, ...DEFAULT_REDACT_PATTERNS] : void 0
	};
}
function redactToolPayloadText(text) {
	return redactToolPayloadTextWithConfig(text, readLoggingConfig());
}
function redactToolPayloadTextWithConfig(text, loggingConfig) {
	if (!text) return text;
	return redactSensitiveText(text, resolveToolPayloadRedaction(loggingConfig));
}
function isSensitiveFieldKey(key) {
	return STRUCTURED_SECRET_FIELD_RE.test(key) || STRUCTURED_SECRET_ENV_FIELD_RE.test(key);
}
function redactSensitiveFieldValueWithOptions(key, value, options) {
	const resolved = resolveRedactOptions(options);
	if (resolved.mode === "off") return value;
	const redacted = redactText(value, resolved.patterns);
	if (redacted !== value || STRUCTURED_APP_PASSWORD_FIELD_RE.test(key)) {
		const appRedacted = redactAppSpecificPasswords(redacted);
		if (appRedacted !== value) return appRedacted;
	}
	if (redacted !== value) return redacted;
	if (isSensitiveFieldKey(key)) return maskToken(value);
	return value;
}
function redactSensitiveFieldValue(key, value, options) {
	return redactSensitiveFieldValueWithOptions(key, value, options ?? resolveToolPayloadRedaction());
}
function redactSensitiveFieldValueWithConfig(key, value, loggingConfig) {
	return redactSensitiveFieldValueWithOptions(key, value, resolveToolPayloadRedaction(loggingConfig));
}
function isPlainRedactableObject(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
function redactStructuredSecretValue(key, value, seen, options) {
	if (typeof value === "string") return redactSensitiveFieldValueWithOptions(key, value, options);
	if (value === null || value === void 0) return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
	if (Array.isArray(value)) {
		if (seen.has(value)) return "[Circular]";
		seen.add(value);
		const out = value.map((entry) => redactStructuredSecretValue(key, entry, seen, options));
		seen.delete(value);
		return out;
	}
	if (typeof value === "object") {
		if (seen.has(value)) return "[Circular]";
		if (!isPlainRedactableObject(value)) return value;
		seen.add(value);
		const out = {};
		for (const [nestedKey, nestedValue] of Object.entries(value)) out[nestedKey] = redactStructuredSecretValue(nestedKey, nestedValue, seen, options);
		seen.delete(value);
		return out;
	}
	return value;
}
function redactSecrets(value) {
	const options = resolveToolPayloadRedaction();
	if (typeof value === "string") return redactSensitiveText(value, options);
	if (value === null || value === void 0) return value;
	if (typeof value !== "object") return value;
	return redactStructuredSecretValue("", value, /* @__PURE__ */ new WeakSet(), options);
}
function getDefaultRedactPatterns() {
	return [...DEFAULT_REDACT_PATTERNS];
}
function redactSensitiveLines(lines, resolved) {
	if (resolved.mode === "off" || !resolved.patterns.length || lines.length === 0) return lines;
	return redactText(lines.join("\n"), resolved.patterns).split("\n");
}
//#endregion
export { hasNestedRepetition as _, redactSensitiveFieldValueWithConfig as a, redactToolDetail as c, resolveRedactOptions as d, readLoggingConfig as f, compileSafeRegexDetailed as g, compileSafeRegex as h, redactSensitiveFieldValue as i, redactToolPayloadText as l, compileConfigRegexes as m, isSensitiveFieldKey as n, redactSensitiveLines as o, shouldSkipMutatingLoggingConfigRead as p, redactSecrets as r, redactSensitiveText as s, getDefaultRedactPatterns as t, redactToolPayloadTextWithConfig as u, testRegexWithBoundedInput as v };
