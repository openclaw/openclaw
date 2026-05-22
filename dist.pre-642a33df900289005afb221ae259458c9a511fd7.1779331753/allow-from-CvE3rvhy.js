import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { m as mapAllowFromEntries } from "./channel-config-helpers-xZ4-bv2H.js";
import { t as summarizeStringEntries } from "./string-sample-BjNKk4nO.js";
import { n as isAllowedParsedChatSender$1 } from "./chat-target-prefixes-DKnHakTu.js";
//#region src/channels/allowlists/resolve-utils.ts
function dedupeAllowlistEntries(entries) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const entry of entries) {
		const normalized = entry.trim();
		if (!normalized) continue;
		const key = normalizeLowercaseStringOrEmpty(normalized);
		if (seen.has(key)) continue;
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
		const trimmed = normalizeOptionalString(entry) ?? "";
		const resolved = params.resolvedMap.get(trimmed);
		if (resolved?.resolved && resolved.id) additions.push(resolved.id);
	}
	return additions;
}
function canonicalizeAllowlistWithResolvedIds(params) {
	const canonicalized = [];
	for (const entry of params.existing ?? []) {
		const trimmed = normalizeOptionalString(entry) ?? "";
		if (!trimmed) continue;
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
		if (!entryConfig || typeof entryConfig !== "object") continue;
		const users = entryConfig.users;
		if (!Array.isArray(users) || users.length === 0) continue;
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
	if (!entry || typeof entry !== "object") return;
	const users = entry.users;
	if (!Array.isArray(users)) return;
	for (const value of users) {
		const trimmed = normalizeOptionalString(value) ?? "";
		if (trimmed && trimmed !== "*") target.add(trimmed);
	}
}
function summarizeMapping(label, mapping, unresolved, runtime) {
	const lines = [];
	if (mapping.length > 0) lines.push(`${label} resolved: ${summarizeStringEntries({
		entries: mapping,
		limit: 6
	})}`);
	if (unresolved.length > 0) lines.push(`${label} unresolved: ${summarizeStringEntries({
		entries: unresolved,
		limit: 6
	})}`);
	if (lines.length > 0) runtime.log?.(lines.join("\n"));
}
//#endregion
//#region src/plugin-sdk/allow-from.ts
/** Lowercase and optionally strip prefixes from allowlist entries before sender comparisons. */
function formatAllowFromLowercase(params) {
	return params.allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => params.stripPrefixRe ? entry.replace(params.stripPrefixRe, "") : entry).map((entry) => normalizeOptionalLowercaseString(entry)).filter((entry) => Boolean(entry));
}
/** Normalize allowlist entries through a channel-provided parser or canonicalizer. */
function formatNormalizedAllowFromEntries(params) {
	return params.allowFrom.map((entry) => String(entry).trim()).filter(Boolean).map((entry) => params.normalizeEntry(entry)).filter((entry) => Boolean(entry));
}
/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
function isNormalizedSenderAllowed(params) {
	const normalizedAllow = formatAllowFromLowercase({
		allowFrom: params.allowFrom,
		stripPrefixRe: params.stripPrefixRe
	});
	if (normalizedAllow.length === 0) return false;
	if (normalizedAllow.includes("*")) return true;
	const sender = normalizeOptionalLowercaseString(String(params.senderId));
	return sender ? normalizedAllow.includes(sender) : false;
}
/** Match allowlist entries against senders, with conversation targets requiring explicit opt-in. */
function isAllowedParsedChatSender(params) {
	return isAllowedParsedChatSender$1(params);
}
/** Clone allowlist resolution entries into a plain serializable shape for UI and docs output. */
function mapBasicAllowlistResolutionEntries(entries) {
	return entries.map((entry) => ({
		input: entry.input,
		resolved: entry.resolved,
		id: entry.id,
		name: entry.name,
		note: entry.note
	}));
}
/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
async function mapAllowlistResolutionInputs(params) {
	const results = [];
	for (const input of params.inputs) results.push(await params.mapInput(input));
	return results;
}
//#endregion
export { mapAllowlistResolutionInputs as a, buildAllowlistResolutionSummary as c, patchAllowlistUsersInConfigEntries as d, summarizeMapping as f, isNormalizedSenderAllowed as i, canonicalizeAllowlistWithResolvedIds as l, formatNormalizedAllowFromEntries as n, mapBasicAllowlistResolutionEntries as o, isAllowedParsedChatSender as r, addAllowlistUserEntriesFromConfigEntry as s, formatAllowFromLowercase as t, mergeAllowlist as u };
