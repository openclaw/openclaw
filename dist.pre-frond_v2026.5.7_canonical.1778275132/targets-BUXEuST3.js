import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/channels/targets.ts
function normalizeTargetId(kind, id) {
	return normalizeLowercaseStringOrEmpty(`${kind}:${id}`);
}
function buildMessagingTarget(kind, id, raw) {
	return {
		kind,
		id,
		raw,
		normalized: normalizeTargetId(kind, id)
	};
}
function ensureTargetId(params) {
	if (!params.pattern.test(params.candidate)) throw new Error(params.errorMessage);
	return params.candidate;
}
function parseTargetMention(params) {
	const match = params.raw.match(params.mentionPattern);
	if (!match?.[1]) return;
	return buildMessagingTarget(params.kind, match[1], params.raw);
}
function parseTargetPrefix(params) {
	if (!params.raw.startsWith(params.prefix)) return;
	const id = params.raw.slice(params.prefix.length).trim();
	return id ? buildMessagingTarget(params.kind, id, params.raw) : void 0;
}
function parseTargetPrefixes(params) {
	for (const entry of params.prefixes) {
		const parsed = parseTargetPrefix({
			raw: params.raw,
			prefix: entry.prefix,
			kind: entry.kind
		});
		if (parsed) return parsed;
	}
}
function parseAtUserTarget(params) {
	if (!params.raw.startsWith("@")) return;
	return buildMessagingTarget("user", ensureTargetId({
		candidate: params.raw.slice(1).trim(),
		pattern: params.pattern,
		errorMessage: params.errorMessage
	}), params.raw);
}
function parseMentionPrefixOrAtUserTarget(params) {
	const mentionTarget = parseTargetMention({
		raw: params.raw,
		mentionPattern: params.mentionPattern,
		kind: "user"
	});
	if (mentionTarget) return mentionTarget;
	const prefixedTarget = parseTargetPrefixes({
		raw: params.raw,
		prefixes: params.prefixes
	});
	if (prefixedTarget) return prefixedTarget;
	return parseAtUserTarget({
		raw: params.raw,
		pattern: params.atUserPattern,
		errorMessage: params.atUserErrorMessage
	});
}
function requireTargetKind(params) {
	const kindLabel = params.kind;
	if (!params.target) throw new Error(`${params.platform} ${kindLabel} id is required.`);
	if (params.target.kind !== params.kind) throw new Error(`${params.platform} ${kindLabel} id is required (use ${kindLabel}:<id>).`);
	return params.target.id;
}
//#endregion
export { parseMentionPrefixOrAtUserTarget as a, parseTargetPrefixes as c, parseAtUserTarget as i, requireTargetKind as l, ensureTargetId as n, parseTargetMention as o, normalizeTargetId as r, parseTargetPrefix as s, buildMessagingTarget as t };
