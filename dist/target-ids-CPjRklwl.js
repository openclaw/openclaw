import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/matrix/src/matrix/target-ids.ts
const MATRIX_PREFIX = "matrix:";
const ROOM_PREFIX = "room:";
const CHANNEL_PREFIX = "channel:";
const USER_PREFIX = "user:";
function stripKnownPrefixes(raw, prefixes) {
	let normalized = raw.trim();
	while (normalized) {
		const lowered = normalizeLowercaseStringOrEmpty(normalized);
		const matched = prefixes.find((prefix) => lowered.startsWith(prefix));
		if (!matched) return normalized;
		normalized = normalized.slice(matched.length).trim();
	}
	return normalized;
}
function resolveMatrixTargetIdentity(raw) {
	const normalized = stripKnownPrefixes(raw, [MATRIX_PREFIX]);
	if (!normalized) return null;
	const lowered = normalizeLowercaseStringOrEmpty(normalized);
	if (lowered.startsWith(USER_PREFIX)) {
		const id = normalized.slice(5).trim();
		return id ? {
			kind: "user",
			id
		} : null;
	}
	if (lowered.startsWith(ROOM_PREFIX)) {
		const id = normalized.slice(5).trim();
		return id ? {
			kind: "room",
			id
		} : null;
	}
	if (lowered.startsWith(CHANNEL_PREFIX)) {
		const id = normalized.slice(8).trim();
		return id ? {
			kind: "room",
			id
		} : null;
	}
	if (isMatrixQualifiedUserId(normalized)) return {
		kind: "user",
		id: normalized
	};
	return {
		kind: "room",
		id: normalized
	};
}
function isMatrixQualifiedUserId(raw) {
	const trimmed = raw.trim();
	return trimmed.startsWith("@") && trimmed.includes(":");
}
function normalizeMatrixResolvableTarget(raw) {
	return stripKnownPrefixes(raw, [
		MATRIX_PREFIX,
		ROOM_PREFIX,
		CHANNEL_PREFIX
	]);
}
function normalizeMatrixMessagingTarget(raw) {
	return stripKnownPrefixes(raw, [
		MATRIX_PREFIX,
		ROOM_PREFIX,
		CHANNEL_PREFIX,
		USER_PREFIX
	]) || void 0;
}
function resolveMatrixDirectUserId(params) {
	if (params.chatType !== "direct") return;
	if (!normalizeMatrixResolvableTarget(params.to ?? "").startsWith("!")) return;
	const userId = stripKnownPrefixes(params.from ?? "", [MATRIX_PREFIX, USER_PREFIX]);
	return isMatrixQualifiedUserId(userId) ? userId : void 0;
}
//#endregion
export { resolveMatrixTargetIdentity as a, resolveMatrixDirectUserId as i, normalizeMatrixMessagingTarget as n, normalizeMatrixResolvableTarget as r, isMatrixQualifiedUserId as t };
