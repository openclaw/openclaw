import { Cp as mapAllowFromEntries } from "./auth-profiles-CuJtivJK.js";
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
function compileSimpleAllowlist(entries) {
	return compileAllowlist(entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean));
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
function resolveAllowlistMatchSimple(params) {
	const allowFrom = compileSimpleAllowlist(params.allowFrom);
	if (allowFrom.set.size === 0) {return { allowed: false };}
	if (allowFrom.wildcard) {return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};}
	const senderId = params.senderId.toLowerCase();
	const senderName = params.senderName?.toLowerCase();
	return resolveAllowlistCandidates({
		compiledAllowlist: allowFrom,
		candidates: [{
			value: senderId,
			source: "id"
		}, ...params.allowNameMatching === true && senderName ? [{
			value: senderName,
			source: "name"
		}] : []]
	});
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
export { patchAllowlistUsersInConfigEntries as a, compileAllowlist as c, resolveCompiledAllowlistMatch as d, mergeAllowlist as i, formatAllowlistMatchMeta as l, buildAllowlistResolutionSummary as n, summarizeMapping as o, canonicalizeAllowlistWithResolvedIds as r, summarizeStringEntries as s, addAllowlistUserEntriesFromConfigEntry as t, resolveAllowlistMatchSimple as u };
