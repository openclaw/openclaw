import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { m as compileConfigRegexes } from "./redact-ok5Q8nmw.js";
import { b as escapeRegExp } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { r as resolveAgentConfig } from "./agent-scope-config-CMp71_27.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { a as normalizeAnyChannelId } from "./registry-CtWyD2pE.js";
import { t as getLoadedChannelPluginById } from "./registry-loaded-BE-rpJc1.js";
//#region src/auto-reply/reply/mentions.ts
function deriveMentionPatterns(identity) {
	const patterns = [];
	const name = normalizeOptionalString(identity?.name);
	if (name) {
		const parts = name.split(/\s+/).filter(Boolean).map(escapeRegExp);
		const re = parts.length ? parts.join(String.raw`\s+`) : escapeRegExp(name);
		patterns.push(String.raw`\b@?${re}\b`);
	}
	const emoji = normalizeOptionalString(identity?.emoji);
	if (emoji) patterns.push(escapeRegExp(emoji));
	return patterns;
}
const BACKSPACE_CHAR = "\b";
const mentionMatchRegexCompileCache = /* @__PURE__ */ new Map();
const mentionStripRegexCompileCache = /* @__PURE__ */ new Map();
const MAX_MENTION_REGEX_COMPILE_CACHE_KEYS = 512;
const mentionPatternWarningCache = /* @__PURE__ */ new Set();
const MAX_MENTION_PATTERN_WARNING_KEYS = 512;
const log = createSubsystemLogger("mentions");
const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
function normalizeMentionPattern(pattern) {
	if (!pattern.includes(BACKSPACE_CHAR)) return pattern;
	return pattern.split(BACKSPACE_CHAR).join("\\b");
}
function normalizeMentionPatterns(patterns) {
	return patterns.map(normalizeMentionPattern);
}
function warnRejectedMentionPattern(pattern, flags, reason) {
	const key = `${flags}::${reason}::${pattern}`;
	if (mentionPatternWarningCache.has(key)) return;
	mentionPatternWarningCache.add(key);
	if (mentionPatternWarningCache.size > MAX_MENTION_PATTERN_WARNING_KEYS) {
		mentionPatternWarningCache.clear();
		mentionPatternWarningCache.add(key);
	}
	log.warn("Ignoring unsupported group mention pattern", {
		pattern,
		flags,
		reason
	});
}
function cacheMentionRegexes(cache, cacheKey, regexes) {
	cache.set(cacheKey, regexes);
	if (cache.size > MAX_MENTION_REGEX_COMPILE_CACHE_KEYS) {
		cache.clear();
		cache.set(cacheKey, regexes);
	}
	return [...regexes];
}
function compileMentionPatternsCached(params) {
	if (params.patterns.length === 0) return [];
	const cacheKey = `${params.flags}\u001e${params.patterns.join("")}`;
	const cached = params.cache.get(cacheKey);
	if (cached) return [...cached];
	const compiled = compileConfigRegexes(params.patterns, params.flags);
	if (params.warnRejected) for (const rejected of compiled.rejected) warnRejectedMentionPattern(rejected.pattern, rejected.flags, rejected.reason);
	return cacheMentionRegexes(params.cache, cacheKey, compiled.regexes);
}
function resolveMentionPatterns(cfg, agentId) {
	if (!cfg) return [];
	const agentConfig = agentId ? resolveAgentConfig(cfg, agentId) : void 0;
	const agentGroupChat = agentConfig?.groupChat;
	if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) return agentGroupChat.mentionPatterns ?? [];
	const globalGroupChat = cfg.messages?.groupChat;
	if (globalGroupChat && Object.hasOwn(globalGroupChat, "mentionPatterns")) return globalGroupChat.mentionPatterns ?? [];
	const derived = deriveMentionPatterns(agentConfig?.identity);
	return derived.length > 0 ? derived : [];
}
function buildMentionRegexes(cfg, agentId) {
	return compileMentionPatternsCached({
		patterns: normalizeMentionPatterns(resolveMentionPatterns(cfg, agentId)),
		flags: "i",
		cache: mentionMatchRegexCompileCache,
		warnRejected: true
	});
}
function normalizeMentionText(text) {
	return normalizeLowercaseStringOrEmpty((text ?? "").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, ""));
}
function matchesMentionPatterns(text, mentionRegexes) {
	if (mentionRegexes.length === 0) return false;
	const cleaned = normalizeMentionText(text ?? "");
	return mentionRegexes.some((re) => re.test(cleaned));
}
function matchesMentionWithExplicit(params) {
	const cleaned = normalizeMentionText(params.text ?? "");
	const explicit = params.explicit?.isExplicitlyMentioned === true;
	const transcriptCleaned = params.transcript ? normalizeMentionText(params.transcript) : "";
	const textToCheck = cleaned || transcriptCleaned;
	return explicit || params.mentionRegexes.some((re) => re.test(textToCheck));
}
function stripStructuralPrefixes(text) {
	if (!text) return "";
	return (text.includes("[Current message - respond to this]") ? text.slice(text.indexOf(CURRENT_MESSAGE_MARKER) + 35).trimStart() : text).replace(/\[[^\]]+\]\s*/g, "").replace(/^[ \t]*[A-Za-z0-9+()\-_. ]+:\s*/gm, "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
}
function stripMentions(text, ctx, cfg, agentId) {
	let result = text;
	const providerId = (ctx.Provider ? normalizeAnyChannelId(ctx.Provider) : null) ?? normalizeOptionalLowercaseString(ctx.Provider) ?? null;
	const providerMentions = providerId ? getLoadedChannelPluginById(providerId)?.mentions : void 0;
	const configRegexes = compileMentionPatternsCached({
		patterns: normalizeMentionPatterns(resolveMentionPatterns(cfg, agentId)),
		flags: "gi",
		cache: mentionStripRegexCompileCache,
		warnRejected: true
	});
	const providerRegexes = providerMentions?.stripRegexes?.({
		ctx,
		cfg,
		agentId
	}) ?? compileMentionPatternsCached({
		patterns: normalizeMentionPatterns(providerMentions?.stripPatterns?.({
			ctx,
			cfg,
			agentId
		}) ?? []),
		flags: "gi",
		cache: mentionStripRegexCompileCache,
		warnRejected: false
	});
	for (const re of [...configRegexes, ...providerRegexes]) result = result.replace(re, " ");
	if (providerMentions?.stripMentions) result = providerMentions.stripMentions({
		text: result,
		ctx,
		cfg,
		agentId
	});
	result = result.replace(/@[0-9+]{5,}/g, " ");
	return result.replace(/\s+/g, " ").trim();
}
//#endregion
export { normalizeMentionText as a, matchesMentionWithExplicit as i, buildMentionRegexes as n, stripMentions as o, matchesMentionPatterns as r, stripStructuralPrefixes as s, CURRENT_MESSAGE_MARKER as t };
