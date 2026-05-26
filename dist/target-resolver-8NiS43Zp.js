import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { a as normalizeChannelTargetInput, i as maybeResolvePluginMessagingTarget, n as buildTargetResolverSignature, o as normalizeTargetForProvider, r as looksLikeTargetId, s as resolveNormalizedTargetInput, t as maybeResolveIdLikeTarget } from "./target-id-resolution-DVSHqxJ3.js";
import { r as unknownTargetError, t as ambiguousTargetError } from "./target-errors-Cjh6i-kG.js";
//#region src/infra/outbound/directory-cache.ts
function buildDirectoryCacheKey(key) {
	const signature = key.signature ?? "default";
	return `${key.channel}:${key.accountId ?? "default"}:${key.kind}:${key.source}:${signature}`;
}
var DirectoryCache = class {
	constructor(ttlMs, maxSize = 2e3) {
		this.ttlMs = ttlMs;
		this.cache = /* @__PURE__ */ new Map();
		this.lastConfigRef = null;
		this.maxSize = Math.max(1, Math.floor(maxSize));
	}
	get(key, cfg) {
		this.resetIfConfigChanged(cfg);
		this.pruneExpired(Date.now());
		const entry = this.cache.get(key);
		if (!entry) return;
		return entry.value;
	}
	set(key, value, cfg) {
		this.resetIfConfigChanged(cfg);
		const now = Date.now();
		this.pruneExpired(now);
		if (this.cache.has(key)) this.cache.delete(key);
		this.cache.set(key, {
			value,
			fetchedAt: now
		});
		this.evictToMaxSize();
	}
	clearMatching(match) {
		for (const key of this.cache.keys()) if (match(key)) this.cache.delete(key);
	}
	clear(cfg) {
		this.cache.clear();
		if (cfg) this.lastConfigRef = cfg;
	}
	resetIfConfigChanged(cfg) {
		if (this.lastConfigRef && this.lastConfigRef !== cfg) this.cache.clear();
		this.lastConfigRef = cfg;
	}
	pruneExpired(now) {
		if (this.ttlMs <= 0) return;
		for (const [cacheKey, entry] of this.cache.entries()) if (now - entry.fetchedAt > this.ttlMs) this.cache.delete(cacheKey);
	}
	evictToMaxSize() {
		while (this.cache.size > this.maxSize) {
			const oldestKey = this.cache.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.cache.delete(oldestKey);
		}
	}
};
//#endregion
//#region src/infra/outbound/target-resolver.ts
function asResolvedMessagingTarget(target) {
	return target;
}
async function resolveChannelTarget(params) {
	return resolveMessagingTarget(params);
}
const directoryCache = new DirectoryCache(1800 * 1e3);
function resetDirectoryCache(params) {
	if (!params?.channel) {
		directoryCache.clear();
		return;
	}
	const channelKey = params.channel;
	const accountKey = params.accountId ?? "default";
	directoryCache.clearMatching((key) => {
		if (!key.startsWith(`${channelKey}:`)) return false;
		if (!params.accountId) return true;
		return key.startsWith(`${channelKey}:${accountKey}:`);
	});
}
function normalizeQuery(value) {
	return normalizeLowercaseStringOrEmpty(value);
}
function stripTargetPrefixes(value) {
	return value.replace(/^(channel|user):/i, "").replace(/^[@#]/, "").trim();
}
function formatTargetDisplay(params) {
	const plugin = getChannelPlugin(params.channel);
	if (plugin?.messaging?.formatTargetDisplay) return plugin.messaging.formatTargetDisplay({
		target: params.target,
		display: params.display,
		kind: params.kind
	});
	const trimmedTarget = params.target.trim();
	const lowered = normalizeLowercaseStringOrEmpty(trimmedTarget);
	const display = params.display?.trim();
	const kind = params.kind ?? (lowered.startsWith("user:") ? "user" : lowered.startsWith("channel:") ? "group" : void 0);
	if (display) {
		if (display.startsWith("#") || display.startsWith("@")) return display;
		if (kind === "user") return `@${display}`;
		if (kind === "group" || kind === "channel") return `#${display}`;
		return display;
	}
	if (!trimmedTarget) return trimmedTarget;
	if (trimmedTarget.startsWith("#") || trimmedTarget.startsWith("@")) return trimmedTarget;
	const channelPrefix = `${params.channel}:`;
	const withoutProvider = lowered.startsWith(channelPrefix) ? trimmedTarget.slice(channelPrefix.length) : trimmedTarget;
	if (/^channel:/i.test(withoutProvider)) return `#${withoutProvider.replace(/^channel:/i, "")}`;
	if (/^user:/i.test(withoutProvider)) return `@${withoutProvider.replace(/^user:/i, "")}`;
	return withoutProvider;
}
function detectTargetKind(channel, raw, preferred) {
	if (preferred) return preferred;
	const trimmed = raw.trim();
	if (!trimmed) return "group";
	const inferredChatType = getChannelPlugin(channel)?.messaging?.inferTargetChatType?.({ to: raw });
	if (inferredChatType === "direct") return "user";
	if (inferredChatType === "channel") return "channel";
	if (inferredChatType === "group") return "group";
	if (trimmed.startsWith("@") || /^<@!?/.test(trimmed) || /^user:/i.test(trimmed)) return "user";
	if (trimmed.startsWith("#") || /^channel:/i.test(trimmed)) return "group";
	return "group";
}
function normalizeDirectoryEntryId(channel, entry) {
	return normalizeTargetForProvider(channel, entry.id) ?? entry.id.trim();
}
function matchesDirectoryEntry(params) {
	const query = normalizeQuery(params.query);
	if (!query) return false;
	return [
		stripTargetPrefixes(normalizeDirectoryEntryId(params.channel, params.entry)),
		params.entry.name ? stripTargetPrefixes(params.entry.name) : "",
		params.entry.handle ? stripTargetPrefixes(params.entry.handle) : ""
	].map((value) => normalizeQuery(value)).filter(Boolean).some((value) => value === query || value.includes(query));
}
function resolveMatch(params) {
	const matches = params.entries.filter((entry) => matchesDirectoryEntry({
		channel: params.channel,
		entry,
		query: params.query
	}));
	if (matches.length === 0) return { kind: "none" };
	if (matches.length === 1) return {
		kind: "single",
		entry: matches[0]
	};
	return {
		kind: "ambiguous",
		entries: matches
	};
}
async function listDirectoryEntries(params) {
	const directory = getChannelPlugin(params.channel)?.directory;
	if (!directory) return [];
	const runtime = params.runtime ?? defaultRuntime;
	const useLive = params.source === "live";
	const fn = params.kind === "user" ? useLive ? directory.listPeersLive ?? directory.listPeers : directory.listPeers : useLive ? directory.listGroupsLive ?? directory.listGroups : directory.listGroups;
	if (!fn) return [];
	return await fn({
		cfg: params.cfg,
		accountId: params.accountId ?? void 0,
		query: params.query ?? void 0,
		limit: void 0,
		runtime
	});
}
async function getDirectoryEntries(params) {
	const signature = buildTargetResolverSignature(params.channel);
	const listParams = {
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		kind: params.kind,
		query: params.query,
		runtime: params.runtime
	};
	const cacheKey = buildDirectoryCacheKey({
		channel: params.channel,
		accountId: params.accountId,
		kind: params.kind,
		source: "cache",
		signature
	});
	const cached = directoryCache.get(cacheKey, params.cfg);
	if (cached) return cached;
	const entries = await listDirectoryEntries({
		...listParams,
		source: "cache"
	});
	if (entries.length > 0 || !params.preferLiveOnMiss) {
		directoryCache.set(cacheKey, entries, params.cfg);
		return entries;
	}
	const liveKey = buildDirectoryCacheKey({
		channel: params.channel,
		accountId: params.accountId,
		kind: params.kind,
		source: "live",
		signature
	});
	const liveEntries = await listDirectoryEntries({
		...listParams,
		source: "live"
	});
	directoryCache.set(liveKey, liveEntries, params.cfg);
	directoryCache.set(cacheKey, liveEntries, params.cfg);
	return liveEntries;
}
function buildNormalizedResolveResult(params) {
	return {
		ok: true,
		target: {
			to: params.normalized,
			kind: params.kind,
			display: stripTargetPrefixes(params.normalized),
			source: "normalized"
		}
	};
}
function pickAmbiguousMatch(entries, mode) {
	if (entries.length === 0) return null;
	if (mode === "first") return entries[0] ?? null;
	const ranked = entries.map((entry) => ({
		entry,
		rank: typeof entry.rank === "number" ? entry.rank : 0
	}));
	const bestRank = Math.max(...ranked.map((item) => item.rank));
	return ranked.find((item) => item.rank === bestRank)?.entry ?? entries[0] ?? null;
}
async function resolveMessagingTarget(params) {
	const raw = normalizeChannelTargetInput(params.input);
	if (!raw) return {
		ok: false,
		error: /* @__PURE__ */ new Error("Target is required")
	};
	const plugin = getChannelPlugin(params.channel);
	const providerLabel = plugin?.meta?.label ?? params.channel;
	const hint = plugin?.messaging?.targetResolver?.hint;
	const kind = detectTargetKind(params.channel, raw, params.preferredKind);
	const normalizedInput = resolveNormalizedTargetInput(params.channel, raw);
	const normalized = normalizedInput?.normalized ?? raw;
	if (normalizedInput && looksLikeTargetId({
		channel: params.channel,
		raw: normalizedInput.raw,
		normalized
	})) {
		const resolvedIdLikeTarget = await maybeResolveIdLikeTarget({
			cfg: params.cfg,
			channel: params.channel,
			input: raw,
			accountId: params.accountId,
			preferredKind: params.preferredKind
		});
		if (resolvedIdLikeTarget) return {
			ok: true,
			target: resolvedIdLikeTarget
		};
		return buildNormalizedResolveResult({
			normalized,
			kind
		});
	}
	const query = stripTargetPrefixes(raw);
	const entries = await getDirectoryEntries({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		kind: kind === "user" ? "user" : "group",
		query,
		runtime: params.runtime,
		preferLiveOnMiss: true
	});
	const match = resolveMatch({
		channel: params.channel,
		entries,
		query
	});
	if (match.kind === "single") {
		const entry = match.entry;
		return {
			ok: true,
			target: {
				to: normalizeDirectoryEntryId(params.channel, entry),
				kind,
				display: entry.name ?? entry.handle ?? stripTargetPrefixes(entry.id),
				source: "directory"
			}
		};
	}
	if (match.kind === "ambiguous") {
		const mode = params.resolveAmbiguous ?? "error";
		if (mode !== "error") {
			const best = pickAmbiguousMatch(match.entries, mode);
			if (best) return {
				ok: true,
				target: {
					to: normalizeDirectoryEntryId(params.channel, best),
					kind,
					display: best.name ?? best.handle ?? stripTargetPrefixes(best.id),
					source: "directory"
				}
			};
		}
		return {
			ok: false,
			error: ambiguousTargetError(providerLabel, raw, hint),
			candidates: match.entries
		};
	}
	const resolvedFallbackTarget = asResolvedMessagingTarget(await maybeResolvePluginMessagingTarget({
		cfg: params.cfg,
		channel: params.channel,
		input: raw,
		accountId: params.accountId,
		preferredKind: params.preferredKind
	}));
	if (resolvedFallbackTarget) return {
		ok: true,
		target: resolvedFallbackTarget
	};
	return {
		ok: false,
		error: unknownTargetError(providerLabel, raw, hint)
	};
}
async function lookupDirectoryDisplay(params) {
	const normalized = normalizeTargetForProvider(params.channel, params.targetId) ?? params.targetId;
	const [groups, users] = await Promise.all([getDirectoryEntries({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		kind: "group",
		runtime: params.runtime,
		preferLiveOnMiss: false
	}), getDirectoryEntries({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		kind: "user",
		runtime: params.runtime,
		preferLiveOnMiss: false
	})]);
	const findMatch = (candidates) => candidates.find((candidate) => normalizeDirectoryEntryId(params.channel, candidate) === normalized);
	const entry = findMatch(groups) ?? findMatch(users);
	return entry?.name ?? entry?.handle ?? void 0;
}
//#endregion
export { resolveChannelTarget as i, lookupDirectoryDisplay as n, resetDirectoryCache as r, formatTargetDisplay as t };
