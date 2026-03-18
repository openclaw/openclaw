import { i as resolveCompiledAllowlistMatch, t as compileAllowlist } from "./plugins-DC9n978g.js";
import { i as normalizeStringEntriesLower, n as normalizeHyphenSlug, r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
//#region extensions/slack/src/monitor/allow-list.ts
const SLACK_SLUG_CACHE_MAX = 512;
const slackSlugCache = /* @__PURE__ */ new Map();
function normalizeSlackSlug(raw) {
	const key = raw ?? "";
	const cached = slackSlugCache.get(key);
	if (cached !== void 0) return cached;
	const normalized = normalizeHyphenSlug(raw);
	slackSlugCache.set(key, normalized);
	if (slackSlugCache.size > SLACK_SLUG_CACHE_MAX) {
		const oldest = slackSlugCache.keys().next();
		if (!oldest.done) slackSlugCache.delete(oldest.value);
	}
	return normalized;
}
function normalizeAllowList(list) {
	return normalizeStringEntries(list);
}
function normalizeAllowListLower(list) {
	return normalizeStringEntriesLower(list);
}
function normalizeSlackAllowOwnerEntry(entry) {
	const trimmed = entry.trim().toLowerCase();
	if (!trimmed || trimmed === "*") return;
	const withoutPrefix = trimmed.replace(/^(slack:|user:)/, "");
	return /^u[a-z0-9]+$/.test(withoutPrefix) ? withoutPrefix : void 0;
}
function resolveSlackAllowListMatch(params) {
	const compiledAllowList = compileAllowlist(params.allowList);
	const id = params.id?.toLowerCase();
	const name = params.name?.toLowerCase();
	const slug = normalizeSlackSlug(name);
	return resolveCompiledAllowlistMatch({
		compiledAllowlist: compiledAllowList,
		candidates: [
			{
				value: id,
				source: "id"
			},
			{
				value: id ? `slack:${id}` : void 0,
				source: "prefixed-id"
			},
			{
				value: id ? `user:${id}` : void 0,
				source: "prefixed-user"
			},
			...params.allowNameMatching === true ? [
				{
					value: name,
					source: "name"
				},
				{
					value: name ? `slack:${name}` : void 0,
					source: "prefixed-name"
				},
				{
					value: slug,
					source: "slug"
				}
			] : []
		]
	});
}
function allowListMatches(params) {
	return resolveSlackAllowListMatch(params).allowed;
}
function resolveSlackUserAllowed(params) {
	const allowList = normalizeAllowListLower(params.allowList);
	if (allowList.length === 0) return true;
	return allowListMatches({
		allowList,
		id: params.userId,
		name: params.userName,
		allowNameMatching: params.allowNameMatching
	});
}
//#endregion
export { normalizeSlackSlug as a, normalizeSlackAllowOwnerEntry as i, normalizeAllowList as n, resolveSlackAllowListMatch as o, normalizeAllowListLower as r, resolveSlackUserAllowed as s, allowListMatches as t };
