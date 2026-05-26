import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { i as resolveAllowlistMatchByCandidates } from "./allowlist-match-D8Bi9YxS.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/matrix/src/matrix/monitor/allowlist.ts
function normalizeAllowList(list) {
	return normalizeStringEntries(list);
}
function normalizeMatrixUser(raw) {
	const value = (raw ?? "").trim();
	if (!value) return "";
	if (!value.startsWith("@") || !value.includes(":")) return normalizeLowercaseStringOrEmpty(value);
	const withoutAt = value.slice(1);
	const splitIndex = withoutAt.indexOf(":");
	if (splitIndex === -1) return normalizeLowercaseStringOrEmpty(value);
	const localpart = normalizeLowercaseStringOrEmpty(withoutAt.slice(0, splitIndex));
	const server = normalizeLowercaseStringOrEmpty(withoutAt.slice(splitIndex + 1));
	if (!server) return normalizeLowercaseStringOrEmpty(value);
	return `@${localpart}:${server}`;
}
function normalizeMatrixUserId(raw) {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (lowered.startsWith("matrix:")) return normalizeMatrixUser(trimmed.slice(7));
	if (lowered.startsWith("user:")) return normalizeMatrixUser(trimmed.slice(5));
	return normalizeMatrixUser(trimmed);
}
function normalizeMatrixAllowListEntry(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	if (trimmed === "*") return trimmed;
	const lowered = normalizeLowercaseStringOrEmpty(trimmed);
	if (lowered.startsWith("matrix:")) return `matrix:${normalizeMatrixUser(trimmed.slice(7))}`;
	if (lowered.startsWith("user:")) return `user:${normalizeMatrixUser(trimmed.slice(5))}`;
	return normalizeMatrixUser(trimmed);
}
function normalizeMatrixAllowList(list) {
	return normalizeAllowList(list).map((entry) => normalizeMatrixAllowListEntry(entry));
}
function resolveMatrixAllowListMatch(params) {
	const allowList = params.allowList;
	if (allowList.length === 0) return { allowed: false };
	if (allowList.includes("*")) return {
		allowed: true,
		matchKey: "*",
		matchSource: "wildcard"
	};
	const userId = normalizeMatrixUser(params.userId);
	return resolveAllowlistMatchByCandidates({
		allowList,
		candidates: [
			{
				value: userId,
				source: "id"
			},
			{
				value: userId ? `matrix:${userId}` : "",
				source: "prefixed-id"
			},
			{
				value: userId ? `user:${userId}` : "",
				source: "prefixed-user"
			}
		]
	});
}
//#endregion
export { normalizeMatrixUserId as n, resolveMatrixAllowListMatch as r, normalizeMatrixAllowList as t };
