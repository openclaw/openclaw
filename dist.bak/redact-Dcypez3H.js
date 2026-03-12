import { Nt as resolveNodeRequireFromMeta } from "./entry.js";

//#region src/security/safe-regex.ts
const SAFE_REGEX_CACHE_MAX = 256;
const safeRegexCache = /* @__PURE__ */ new Map();
function hasNestedRepetition(source) {
	const frames = [{
		lastToken: null,
		containsRepetition: false
	}];
	let inCharClass = false;
	const emitToken = (token) => {
		const frame = frames[frames.length - 1];
		frame.lastToken = token;
		if (token.containsRepetition) frame.containsRepetition = true;
	};
	for (let i = 0; i < source.length; i += 1) {
		const ch = source[i];
		if (ch === "\\") {
			i += 1;
			emitToken({ containsRepetition: false });
			continue;
		}
		if (inCharClass) {
			if (ch === "]") inCharClass = false;
			continue;
		}
		if (ch === "[") {
			inCharClass = true;
			emitToken({ containsRepetition: false });
			continue;
		}
		if (ch === "(") {
			frames.push({
				lastToken: null,
				containsRepetition: false
			});
			continue;
		}
		if (ch === ")") {
			if (frames.length > 1) emitToken({ containsRepetition: frames.pop().containsRepetition });
			continue;
		}
		if (ch === "|") {
			const frame = frames[frames.length - 1];
			frame.lastToken = null;
			continue;
		}
		const quantifier = readQuantifier(source, i);
		if (quantifier) {
			const frame = frames[frames.length - 1];
			const token = frame.lastToken;
			if (!token) continue;
			if (token.containsRepetition) return true;
			token.containsRepetition = true;
			frame.containsRepetition = true;
			i += quantifier.consumed - 1;
			continue;
		}
		emitToken({ containsRepetition: false });
	}
	return false;
}
function readQuantifier(source, index) {
	const ch = source[index];
	if (ch === "*" || ch === "+" || ch === "?") return { consumed: source[index + 1] === "?" ? 2 : 1 };
	if (ch !== "{") return null;
	let i = index + 1;
	while (i < source.length && /\d/.test(source[i])) i += 1;
	if (i === index + 1) return null;
	if (source[i] === ",") {
		i += 1;
		while (i < source.length && /\d/.test(source[i])) i += 1;
	}
	if (source[i] !== "}") return null;
	i += 1;
	if (source[i] === "?") i += 1;
	return { consumed: i - index };
}
function compileSafeRegex(source, flags = "") {
	const trimmed = source.trim();
	if (!trimmed) return null;
	const cacheKey = `${flags}::${trimmed}`;
	if (safeRegexCache.has(cacheKey)) return safeRegexCache.get(cacheKey) ?? null;
	let compiled = null;
	if (!hasNestedRepetition(trimmed)) try {
		compiled = new RegExp(trimmed, flags);
	} catch {
		compiled = null;
	}
	safeRegexCache.set(cacheKey, compiled);
	if (safeRegexCache.size > SAFE_REGEX_CACHE_MAX) {
		const oldestKey = safeRegexCache.keys().next().value;
		if (oldestKey) safeRegexCache.delete(oldestKey);
	}
	return compiled;
}

//#endregion
//#region src/logging/redact.ts
const requireConfig = resolveNodeRequireFromMeta(import.meta.url);
const DEFAULT_REDACT_MODE = "tools";
const DEFAULT_REDACT_MIN_LENGTH = 18;
const DEFAULT_REDACT_KEEP_START = 6;
const DEFAULT_REDACT_KEEP_END = 4;
const DEFAULT_REDACT_PATTERNS = [
	String.raw`\b[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[=:]\s*(["']?)([^\s"'\\]+)\1`,
	String.raw`"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)"\s*:\s*"([^"]+)"`,
	String.raw`--(?:api[-_]?key|token|secret|password|passwd)\s+(["']?)([^\s"']+)\1`,
	String.raw`Authorization\s*[:=]\s*Bearer\s+([A-Za-z0-9._\-+=]+)`,
	String.raw`\bBearer\s+([A-Za-z0-9._\-+=]{18,})\b`,
	String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----`,
	String.raw`\b(sk-[A-Za-z0-9_-]{8,})\b`,
	String.raw`\b(ghp_[A-Za-z0-9]{20,})\b`,
	String.raw`\b(github_pat_[A-Za-z0-9_]{20,})\b`,
	String.raw`\b(xox[baprs]-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(xapp-[A-Za-z0-9-]{10,})\b`,
	String.raw`\b(gsk_[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(AIza[0-9A-Za-z\-_]{20,})\b`,
	String.raw`\b(pplx-[A-Za-z0-9_-]{10,})\b`,
	String.raw`\b(npm_[A-Za-z0-9]{10,})\b`,
	String.raw`\bbot(\d{6,}:[A-Za-z0-9_-]{20,})\b`,
	String.raw`\b(\d{6,}:[A-Za-z0-9_-]{20,})\b`
];
function normalizeMode(value) {
	return value === "off" ? "off" : DEFAULT_REDACT_MODE;
}
function parsePattern(raw) {
	if (!raw.trim()) return null;
	const match = raw.match(/^\/(.+)\/([gimsuy]*)$/);
	if (match) {
		const flags = match[2].includes("g") ? match[2] : `${match[2]}g`;
		return compileSafeRegex(match[1], flags);
	}
	return compileSafeRegex(raw, "gi");
}
function resolvePatterns(value) {
	return (value?.length ? value : DEFAULT_REDACT_PATTERNS).map(parsePattern).filter((re) => Boolean(re));
}
function maskToken(token) {
	if (token.length < DEFAULT_REDACT_MIN_LENGTH) return "***";
	return `${token.slice(0, DEFAULT_REDACT_KEEP_START)}…${token.slice(-DEFAULT_REDACT_KEEP_END)}`;
}
function redactPemBlock(block) {
	const lines = block.split(/\r?\n/).filter(Boolean);
	if (lines.length < 2) return "***";
	return `${lines[0]}\n…redacted…\n${lines[lines.length - 1]}`;
}
function redactMatch(match, groups) {
	if (match.includes("PRIVATE KEY-----")) return redactPemBlock(match);
	const token = groups.filter((value) => typeof value === "string" && value.length > 0).at(-1) ?? match;
	const masked = maskToken(token);
	if (token === match) return masked;
	return match.replace(token, masked);
}
function redactText(text, patterns) {
	let next = text;
	for (const pattern of patterns) next = next.replace(pattern, (...args) => redactMatch(args[0], args.slice(1, args.length - 2)));
	return next;
}
function resolveConfigRedaction() {
	let cfg;
	try {
		cfg = (requireConfig?.("../config/config.js"))?.loadConfig?.().logging;
	} catch {
		cfg = void 0;
	}
	return {
		mode: normalizeMode(cfg?.redactSensitive),
		patterns: cfg?.redactPatterns
	};
}
function redactSensitiveText(text, options) {
	if (!text) return text;
	const resolved = options ?? resolveConfigRedaction();
	if (normalizeMode(resolved.mode) === "off") return text;
	const patterns = resolvePatterns(resolved.patterns);
	if (!patterns.length) return text;
	return redactText(text, patterns);
}
function redactToolDetail(detail) {
	const resolved = resolveConfigRedaction();
	if (normalizeMode(resolved.mode) !== "tools") return detail;
	return redactSensitiveText(detail, resolved);
}
function getDefaultRedactPatterns() {
	return [...DEFAULT_REDACT_PATTERNS];
}

//#endregion
export { compileSafeRegex as i, redactSensitiveText as n, redactToolDetail as r, getDefaultRedactPatterns as t };