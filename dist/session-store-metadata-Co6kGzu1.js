import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import { i as resolveChannelEntryMatch, n as buildChannelKeyCandidates } from "./channel-config-BI04LRnO.js";
import "./agent-media-payload-Coh_QzX4.js";
import "./channel-reply-options-runtime-DZhqLM8b.js";
import "./channel-targets-DLOcH73y.js";
import { a as resolveMatrixTargetIdentity, i as resolveMatrixDirectUserId } from "./target-ids-CPjRklwl.js";
//#region extensions/matrix/src/matrix/monitor/rooms.ts
function readLegacyRoomAllowAlias(room) {
	const rawRoom = room;
	return typeof rawRoom?.allow === "boolean" ? rawRoom.allow : void 0;
}
function resolveMatrixRoomConfig(params) {
	const rooms = params.rooms ?? {};
	const allowlistConfigured = Object.keys(rooms).length > 0;
	const { entry: matched, key: matchedKey, wildcardEntry, wildcardKey } = resolveChannelEntryMatch({
		entries: rooms,
		keys: buildChannelKeyCandidates(params.roomId, `room:${params.roomId}`, ...params.aliases),
		wildcardKey: "*"
	});
	const resolved = matched ?? wildcardEntry;
	const legacyAllow = readLegacyRoomAllowAlias(resolved);
	return {
		allowed: resolved ? resolved.enabled !== false && legacyAllow !== false : false,
		allowlistConfigured,
		config: resolved,
		matchKey: matchedKey ?? wildcardKey,
		matchSource: matched ? "direct" : wildcardEntry ? "wildcard" : void 0
	};
}
//#endregion
//#region extensions/matrix/src/matrix/session-store-metadata.ts
function trimMaybeString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function resolveMatrixRoomTargetId(value) {
	const trimmed = trimMaybeString(value);
	if (!trimmed) return;
	const target = resolveMatrixTargetIdentity(trimmed);
	return target?.kind === "room" && target.id.startsWith("!") ? target.id : void 0;
}
function resolveMatrixSessionAccountId(value) {
	const trimmed = trimMaybeString(value);
	return trimmed ? normalizeAccountId(trimmed) : void 0;
}
function resolveMatrixStoredRoomId(params) {
	return resolveMatrixRoomTargetId(params.deliveryTo) ?? resolveMatrixRoomTargetId(params.lastTo) ?? resolveMatrixRoomTargetId(params.originNativeChannelId) ?? resolveMatrixRoomTargetId(params.originTo);
}
function resolveMatrixStoredSessionMeta(entry) {
	if (!entry) return null;
	const channel = trimMaybeString(entry.deliveryContext?.channel) ?? trimMaybeString(entry.lastChannel) ?? trimMaybeString(entry.origin?.provider);
	const accountId = resolveMatrixSessionAccountId(entry.deliveryContext?.accountId ?? entry.lastAccountId ?? entry.origin?.accountId) ?? void 0;
	const roomId = resolveMatrixStoredRoomId({
		deliveryTo: entry.deliveryContext?.to,
		lastTo: entry.lastTo,
		originNativeChannelId: entry.origin?.nativeChannelId,
		originTo: entry.origin?.to
	});
	const chatType = trimMaybeString(entry.origin?.chatType) ?? trimMaybeString(entry.chatType) ?? void 0;
	const directUserId = chatType === "direct" ? trimMaybeString(entry.origin?.nativeDirectUserId) ?? resolveMatrixDirectUserId({
		from: trimMaybeString(entry.origin?.from),
		to: (roomId ? `room:${roomId}` : void 0) ?? trimMaybeString(entry.deliveryContext?.to) ?? trimMaybeString(entry.lastTo) ?? trimMaybeString(entry.origin?.to),
		chatType
	}) : void 0;
	if (!channel && !accountId && !roomId && !directUserId) return null;
	return {
		...channel ? { channel } : {},
		...accountId ? { accountId } : {},
		...roomId ? { roomId } : {},
		...directUserId ? { directUserId } : {}
	};
}
//#endregion
export { resolveMatrixRoomConfig as n, resolveMatrixStoredSessionMeta as t };
