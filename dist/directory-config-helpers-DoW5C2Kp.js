import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
//#region src/channels/plugins/directory-config-helpers.ts
function resolveDirectoryQuery(query) {
	return normalizeLowercaseStringOrEmpty(query);
}
function resolveDirectoryLimit(limit) {
	return typeof limit === "number" && limit > 0 ? limit : void 0;
}
function applyDirectoryQueryAndLimit(ids, params) {
	const q = resolveDirectoryQuery(params.query);
	const limit = resolveDirectoryLimit(params.limit);
	const filtered = [];
	for (const id of ids) {
		if (q && !normalizeLowercaseStringOrEmpty(id).includes(q)) continue;
		filtered.push(id);
		if (typeof limit === "number" && filtered.length >= limit) break;
	}
	return filtered;
}
function toDirectoryEntries(kind, ids) {
	const entries = [];
	for (const id of ids) entries.push({
		kind,
		id
	});
	return entries;
}
function collectDirectoryIdsFromEntries(params) {
	const ids = [];
	for (const value of params.entries ?? []) {
		const entry = normalizeOptionalString(String(value)) ?? "";
		if (!entry || entry === "*") continue;
		const id = normalizeOptionalString(params.normalizeId ? params.normalizeId(entry) : entry) ?? "";
		if (id) ids.push(id);
	}
	return ids;
}
function collectDirectoryIdsFromMapKeys(params) {
	const ids = [];
	for (const key of Object.keys(params.groups ?? {})) {
		const entry = normalizeOptionalString(key) ?? "";
		if (!entry || entry === "*") continue;
		const id = normalizeOptionalString(params.normalizeId ? params.normalizeId(entry) : entry) ?? "";
		if (id) ids.push(id);
	}
	return ids;
}
function dedupeDirectoryIds(ids) {
	const deduped = [];
	const seen = /* @__PURE__ */ new Set();
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		deduped.push(id);
	}
	return deduped;
}
function collectNormalizedDirectoryIds(params) {
	const ids = /* @__PURE__ */ new Set();
	for (const source of params.sources) for (const value of source) {
		const raw = normalizeOptionalString(value) ?? "";
		if (!raw || raw === "*") continue;
		const trimmed = normalizeOptionalString(params.normalizeId(raw)) ?? "";
		if (trimmed) ids.add(trimmed);
	}
	return Array.from(ids);
}
function listDirectoryEntriesFromSources(params) {
	const ids = collectNormalizedDirectoryIds({
		sources: params.sources,
		normalizeId: params.normalizeId
	});
	return toDirectoryEntries(params.kind, applyDirectoryQueryAndLimit(ids, params));
}
function listInspectedDirectoryEntriesFromSources(params) {
	const account = params.inspectAccount(params.cfg, params.accountId);
	if (!account) return [];
	return listDirectoryEntriesFromSources({
		kind: params.kind,
		sources: params.resolveSources(account),
		query: params.query,
		limit: params.limit,
		normalizeId: params.normalizeId
	});
}
function createInspectedDirectoryEntriesLister(params) {
	return async (configParams) => listInspectedDirectoryEntriesFromSources({
		...configParams,
		...params
	});
}
function listResolvedDirectoryEntriesFromSources(params) {
	const account = params.resolveAccount(params.cfg, params.accountId);
	return listDirectoryEntriesFromSources({
		kind: params.kind,
		sources: params.resolveSources(account),
		query: params.query,
		limit: params.limit,
		normalizeId: params.normalizeId
	});
}
function createResolvedDirectoryEntriesLister(params) {
	return async (configParams) => listResolvedDirectoryEntriesFromSources({
		...configParams,
		...params
	});
}
function listDirectoryUserEntriesFromAllowFrom(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeId
	})), params));
}
function listDirectoryUserEntriesFromAllowFromAndMapKeys(params) {
	return toDirectoryEntries("user", applyDirectoryQueryAndLimit(dedupeDirectoryIds([...collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeAllowFromId
	}), ...collectDirectoryIdsFromMapKeys({
		groups: params.map,
		normalizeId: params.normalizeMapKeyId
	})]), params));
}
function listDirectoryGroupEntriesFromMapKeys(params) {
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(dedupeDirectoryIds(collectDirectoryIdsFromMapKeys({
		groups: params.groups,
		normalizeId: params.normalizeId
	})), params));
}
function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params) {
	return toDirectoryEntries("group", applyDirectoryQueryAndLimit(dedupeDirectoryIds([...collectDirectoryIdsFromMapKeys({
		groups: params.groups,
		normalizeId: params.normalizeMapKeyId
	}), ...collectDirectoryIdsFromEntries({
		entries: params.allowFrom,
		normalizeId: params.normalizeAllowFromId
	})]), params));
}
function listResolvedDirectoryUserEntriesFromAllowFrom(params) {
	const account = params.resolveAccount(params.cfg, params.accountId);
	return listDirectoryUserEntriesFromAllowFrom({
		allowFrom: params.resolveAllowFrom(account),
		query: params.query,
		limit: params.limit,
		normalizeId: params.normalizeId
	});
}
function listResolvedDirectoryGroupEntriesFromMapKeys(params) {
	const account = params.resolveAccount(params.cfg, params.accountId);
	return listDirectoryGroupEntriesFromMapKeys({
		groups: params.resolveGroups(account),
		query: params.query,
		limit: params.limit,
		normalizeId: params.normalizeId
	});
}
//#endregion
export { listDirectoryEntriesFromSources as a, listDirectoryUserEntriesFromAllowFrom as c, listResolvedDirectoryEntriesFromSources as d, listResolvedDirectoryGroupEntriesFromMapKeys as f, createResolvedDirectoryEntriesLister as i, listDirectoryUserEntriesFromAllowFromAndMapKeys as l, toDirectoryEntries as m, collectNormalizedDirectoryIds as n, listDirectoryGroupEntriesFromMapKeys as o, listResolvedDirectoryUserEntriesFromAllowFrom as p, createInspectedDirectoryEntriesLister as r, listDirectoryGroupEntriesFromMapKeysAndAllowFrom as s, applyDirectoryQueryAndLimit as t, listInspectedDirectoryEntriesFromSources as u };
