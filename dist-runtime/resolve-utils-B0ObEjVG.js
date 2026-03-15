import { Sn as wrapExternalContent, kl as mapAllowFromEntries } from "./model-selection-BJ_ZbQnz.js";
//#region src/channels/allowlist-match.ts
function formatAllowlistMatchMeta(match) {
	return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}
function compileAllowlist(entries) {
	const set = new Set(entries.filter(Boolean));
	return {
		set,
		wildcard: set.has("*")
	};
}
function resolveAllowlistCandidates(params) {
	for (const candidate of params.candidates) {
		if (!candidate.value) {continue;}
		if (params.compiledAllowlist.set.has(candidate.value)) {return {
			allowed: true,
			matchKey: candidate.value,
			matchSource: candidate.source
		};}
	}
	return { allowed: false };
}
function resolveCompiledAllowlistMatch(params) {
	if (params.compiledAllowlist.set.size === 0) {return { allowed: false };}
	if (params.compiledAllowlist.wildcard) {return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};}
	return resolveAllowlistCandidates(params);
}
//#endregion
//#region src/security/channel-metadata.ts
const DEFAULT_MAX_CHARS = 800;
const DEFAULT_MAX_ENTRY_CHARS = 400;
function normalizeEntry(entry) {
	return entry.replace(/\s+/g, " ").trim();
}
function truncateText(value, maxChars) {
	if (maxChars <= 0) {return "";}
	if (value.length <= maxChars) {return value;}
	return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
function buildUntrustedChannelMetadata(params) {
	const deduped = params.entries.map((entry) => typeof entry === "string" ? normalizeEntry(entry) : "").filter((entry) => Boolean(entry)).map((entry) => truncateText(entry, DEFAULT_MAX_ENTRY_CHARS)).filter((entry, index, list) => list.indexOf(entry) === index);
	if (deduped.length === 0) {return;}
	const body = deduped.join("\n");
	return wrapExternalContent(truncateText(`${`UNTRUSTED channel metadata (${params.source})`}\n${`${params.label}:\n${body}`}`, params.maxChars ?? DEFAULT_MAX_CHARS), {
		source: "channel_metadata",
		includeWarning: false
	});
}
//#endregion
//#region src/utils/chunk-items.ts
function chunkItems(items, size) {
	if (size <= 0) {return [Array.from(items)];}
	const rows = [];
	for (let i = 0; i < items.length; i += size) {rows.push(items.slice(i, i + size));}
	return rows;
}
//#endregion
//#region src/shared/string-sample.ts
function summarizeStringEntries(params) {
	const entries = params.entries ?? [];
	if (entries.length === 0) {return params.emptyText ?? "";}
	const limit = Math.max(1, Math.floor(params.limit ?? 6));
	const sample = entries.slice(0, limit);
	const suffix = entries.length > sample.length ? ` (+${entries.length - sample.length})` : "";
	return `${sample.join(", ")}${suffix}`;
}
//#endregion
//#region src/channels/allowlists/resolve-utils.ts
function dedupeAllowlistEntries(entries) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of entries) {
		const normalized = entry.trim();
		if (!normalized) {continue;}
		const key = normalized.toLowerCase();
		if (seen.has(key)) {continue;}
		seen.add(key);
		deduped.push(normalized);
	}
	return deduped;
}
function mergeAllowlist(params) {
	return dedupeAllowlistEntries([...mapAllowFromEntries(params.existing), ...params.additions]);
}
function buildAllowlistResolutionSummary(resolvedUsers, opts) {
	const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
	const resolvedOk = (entry) => Boolean(entry.resolved && entry.id);
	const formatResolved = opts?.formatResolved ?? ((entry) => `${entry.input}→${entry.id}`);
	const formatUnresolved = opts?.formatUnresolved ?? ((entry) => entry.input);
	const mapping = resolvedUsers.filter(resolvedOk).map(formatResolved);
	const additions = resolvedUsers.filter(resolvedOk).map((entry) => entry.id).filter((entry) => Boolean(entry));
	return {
		resolvedMap,
		mapping,
		unresolved: resolvedUsers.filter((entry) => !resolvedOk(entry)).map(formatUnresolved),
		additions
	};
}
function resolveAllowlistIdAdditions(params) {
	const additions = [];
	for (const entry of params.existing) {
		const trimmed = String(entry).trim();
		const resolved = params.resolvedMap.get(trimmed);
		if (resolved?.resolved && resolved.id) {additions.push(resolved.id);}
	}
	return additions;
}
function canonicalizeAllowlistWithResolvedIds(params) {
	const canonicalized = [];
	for (const entry of params.existing ?? []) {
		const trimmed = String(entry).trim();
		if (!trimmed) {continue;}
		if (trimmed === "*") {
			canonicalized.push(trimmed);
			continue;
		}
		const resolved = params.resolvedMap.get(trimmed);
		canonicalized.push(resolved?.resolved && resolved.id ? resolved.id : trimmed);
	}
	return dedupeAllowlistEntries(canonicalized);
}
function patchAllowlistUsersInConfigEntries(params) {
	const nextEntries = { ...params.entries };
	for (const [entryKey, entryConfig] of Object.entries(params.entries)) {
		if (!entryConfig || typeof entryConfig !== "object") {continue;}
		const users = entryConfig.users;
		if (!Array.isArray(users) || users.length === 0) {continue;}
		const resolvedUsers = params.strategy === "canonicalize" ? canonicalizeAllowlistWithResolvedIds({
			existing: users,
			resolvedMap: params.resolvedMap
		}) : mergeAllowlist({
			existing: users,
			additions: resolveAllowlistIdAdditions({
				existing: users,
				resolvedMap: params.resolvedMap
			})
		});
		nextEntries[entryKey] = {
			...entryConfig,
			users: resolvedUsers
		};
	}
	return nextEntries;
}
function addAllowlistUserEntriesFromConfigEntry(target, entry) {
	if (!entry || typeof entry !== "object") {return;}
	const users = entry.users;
	if (!Array.isArray(users)) {return;}
	for (const value of users) {
		const trimmed = String(value).trim();
		if (trimmed && trimmed !== "*") {target.add(trimmed);}
	}
}
function summarizeMapping(label, mapping, unresolved, runtime) {
	const lines = [];
	if (mapping.length > 0) {lines.push(`${label} resolved: ${summarizeStringEntries({
		entries: mapping,
		limit: 6
	})}`);}
	if (unresolved.length > 0) {lines.push(`${label} unresolved: ${summarizeStringEntries({
		entries: unresolved,
		limit: 6
	})}`);}
	if (lines.length > 0) {runtime.log?.(lines.join("\n"));}
}
//#endregion
export { patchAllowlistUsersInConfigEntries as a, chunkItems as c, formatAllowlistMatchMeta as d, resolveCompiledAllowlistMatch as f, mergeAllowlist as i, buildUntrustedChannelMetadata as l, buildAllowlistResolutionSummary as n, summarizeMapping as o, canonicalizeAllowlistWithResolvedIds as r, summarizeStringEntries as s, addAllowlistUserEntriesFromConfigEntry as t, compileAllowlist as u };
