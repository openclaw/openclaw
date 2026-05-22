import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/channels/channel-config.ts
function applyChannelMatchMeta(result, match) {
	if (match.matchKey && match.matchSource) {
		result.matchKey = match.matchKey;
		result.matchSource = match.matchSource;
	}
	return result;
}
function resolveChannelMatchConfig(match, resolveEntry) {
	if (!match.entry) return null;
	return applyChannelMatchMeta(resolveEntry(match.entry), match);
}
function normalizeChannelSlug(value) {
	return normalizeLowercaseStringOrEmpty(value).replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function buildChannelKeyCandidates(...keys) {
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	for (const key of keys) {
		if (typeof key !== "string") continue;
		const trimmed = key.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		candidates.push(trimmed);
	}
	return candidates;
}
function resolveChannelEntryMatch(params) {
	const entries = params.entries ?? {};
	const match = {};
	for (const key of params.keys) {
		if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
		match.entry = entries[key];
		match.key = key;
		break;
	}
	if (params.wildcardKey && Object.prototype.hasOwnProperty.call(entries, params.wildcardKey)) {
		match.wildcardEntry = entries[params.wildcardKey];
		match.wildcardKey = params.wildcardKey;
	}
	return match;
}
function resolveChannelEntryMatchWithFallback(params) {
	const direct = resolveChannelEntryMatch({
		entries: params.entries,
		keys: params.keys,
		wildcardKey: params.wildcardKey
	});
	if (direct.entry && direct.key) return {
		...direct,
		matchKey: direct.key,
		matchSource: "direct"
	};
	const normalizeKey = params.normalizeKey;
	if (normalizeKey) {
		const normalizedKeys = params.keys.map((key) => normalizeKey(key)).filter(Boolean);
		if (normalizedKeys.length > 0) for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
			const normalizedEntry = normalizeKey(entryKey);
			if (normalizedEntry && normalizedKeys.includes(normalizedEntry)) return {
				...direct,
				entry,
				key: entryKey,
				matchKey: entryKey,
				matchSource: "direct"
			};
		}
	}
	const parentKeys = params.parentKeys ?? [];
	if (parentKeys.length > 0) {
		const parent = resolveChannelEntryMatch({
			entries: params.entries,
			keys: parentKeys
		});
		if (parent.entry && parent.key) return {
			...direct,
			entry: parent.entry,
			key: parent.key,
			parentEntry: parent.entry,
			parentKey: parent.key,
			matchKey: parent.key,
			matchSource: "parent"
		};
		if (normalizeKey) {
			const normalizedParentKeys = parentKeys.map((key) => normalizeKey(key)).filter(Boolean);
			if (normalizedParentKeys.length > 0) for (const [entryKey, entry] of Object.entries(params.entries ?? {})) {
				const normalizedEntry = normalizeKey(entryKey);
				if (normalizedEntry && normalizedParentKeys.includes(normalizedEntry)) return {
					...direct,
					entry,
					key: entryKey,
					parentEntry: entry,
					parentKey: entryKey,
					matchKey: entryKey,
					matchSource: "parent"
				};
			}
		}
	}
	if (direct.wildcardEntry && direct.wildcardKey) return {
		...direct,
		entry: direct.wildcardEntry,
		key: direct.wildcardKey,
		matchKey: direct.wildcardKey,
		matchSource: "wildcard"
	};
	return direct;
}
function resolveNestedAllowlistDecision(params) {
	if (!params.outerConfigured) return true;
	if (!params.outerMatched) return false;
	if (!params.innerConfigured) return true;
	return params.innerMatched;
}
//#endregion
export { resolveChannelEntryMatchWithFallback as a, resolveChannelEntryMatch as i, buildChannelKeyCandidates as n, resolveChannelMatchConfig as o, normalizeChannelSlug as r, resolveNestedAllowlistDecision as s, applyChannelMatchMeta as t };
