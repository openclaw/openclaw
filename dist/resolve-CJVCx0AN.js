import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as shouldLogVerbose, r as logVerbose } from "./globals-YU5FjfZK.js";
import { t as normalizeChatType } from "./chat-type-D_QPUzR1.js";
import { i as DEFAULT_MAX_CHARS_BY_CAPABILITY, n as DEFAULT_MAX_BYTES, o as DEFAULT_PROMPT } from "./defaults.constants-DeIx7Gbv.js";
import { r as resolveEffectiveMediaEntryCapabilities } from "./entry-capabilities-DGvNSGdr.js";
//#region src/media-understanding/scope.ts
function normalizeDecision(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	if (normalized === "allow") return "allow";
	if (normalized === "deny") return "deny";
}
function normalizeMediaUnderstandingChatType(raw) {
	return normalizeChatType(raw ?? void 0);
}
function resolveMediaUnderstandingScope(params) {
	const scope = params.scope;
	if (!scope) return "allow";
	const channel = normalizeOptionalLowercaseString(params.channel);
	const chatType = normalizeMediaUnderstandingChatType(params.chatType);
	const sessionKey = normalizeOptionalLowercaseString(params.sessionKey) ?? "";
	for (const rule of scope.rules ?? []) {
		if (!rule) continue;
		const action = normalizeDecision(rule.action) ?? "allow";
		const match = rule.match ?? {};
		const matchChannel = normalizeOptionalLowercaseString(match.channel);
		const matchChatType = normalizeMediaUnderstandingChatType(match.chatType);
		const matchPrefix = normalizeOptionalLowercaseString(match.keyPrefix);
		if (matchChannel && matchChannel !== channel) continue;
		if (matchChatType && matchChatType !== chatType) continue;
		if (matchPrefix && !sessionKey.startsWith(matchPrefix)) continue;
		return action;
	}
	return normalizeDecision(scope.default) ?? "allow";
}
//#endregion
//#region src/media-understanding/resolve.ts
function resolveTimeoutMs(seconds, fallbackSeconds) {
	return Math.max(1e3, Math.floor((typeof seconds === "number" && Number.isFinite(seconds) ? seconds : fallbackSeconds) * 1e3));
}
function resolvePrompt(capability, prompt, maxChars) {
	const base = prompt?.trim() || DEFAULT_PROMPT[capability];
	if (!maxChars || capability === "audio") return base;
	return `${base} Respond in at most ${maxChars} characters.`;
}
function resolveMaxChars(params) {
	const { capability, entry, cfg } = params;
	const configured = entry.maxChars ?? params.config?.maxChars ?? cfg.tools?.media?.[capability]?.maxChars;
	if (typeof configured === "number") return configured;
	return DEFAULT_MAX_CHARS_BY_CAPABILITY[capability];
}
function resolveMaxBytes(params) {
	const configured = params.entry.maxBytes ?? params.config?.maxBytes ?? params.cfg.tools?.media?.[params.capability]?.maxBytes;
	if (typeof configured === "number") return configured;
	return DEFAULT_MAX_BYTES[params.capability];
}
function resolveScopeDecision(params) {
	return resolveMediaUnderstandingScope({
		scope: params.scope,
		sessionKey: params.ctx.SessionKey,
		channel: params.ctx.Surface ?? params.ctx.Provider,
		chatType: normalizeMediaUnderstandingChatType(params.ctx.ChatType)
	});
}
function resolveModelEntries(params) {
	const { cfg, capability, config } = params;
	const sharedModels = cfg.tools?.media?.models ?? [];
	const entries = [...(config?.models ?? []).map((entry) => ({
		entry,
		source: "capability"
	})), ...sharedModels.map((entry) => ({
		entry,
		source: "shared"
	}))];
	if (entries.length === 0) return [];
	return entries.filter(({ entry, source }) => {
		const caps = resolveEffectiveMediaEntryCapabilities({
			entry,
			source,
			providerRegistry: params.providerRegistry
		});
		if (!caps || caps.length === 0) {
			if (source === "shared") {
				if (shouldLogVerbose()) logVerbose(`Skipping shared media model without capabilities: ${entry.provider ?? entry.command ?? "unknown"}`);
				return false;
			}
			return true;
		}
		return caps.includes(capability);
	}).map(({ entry }) => entry);
}
function resolveConcurrency(cfg) {
	const configured = cfg.tools?.media?.concurrency;
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return Math.floor(configured);
	return 2;
}
//#endregion
export { resolvePrompt as a, normalizeMediaUnderstandingChatType as c, resolveModelEntries as i, resolveMediaUnderstandingScope as l, resolveMaxBytes as n, resolveScopeDecision as o, resolveMaxChars as r, resolveTimeoutMs as s, resolveConcurrency as t };
