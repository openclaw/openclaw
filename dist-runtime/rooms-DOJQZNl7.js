import { an as resolveChannelEntryMatch, nn as buildChannelKeyCandidates } from "./registry-ep1yQ6WN.js";
import { i as resolveCompiledAllowlistMatch, t as compileAllowlist } from "./plugins-DC9n978g.js";
import { r as normalizeStringEntries } from "./string-normalization-CJJOCyGw.js";
//#region extensions/matrix/src/matrix/monitor/allowlist.ts
function normalizeAllowList(list) {
	return normalizeStringEntries(list);
}
function normalizeMatrixUser(raw) {
	const value = (raw ?? "").trim();
	if (!value) return "";
	if (!value.startsWith("@") || !value.includes(":")) return value.toLowerCase();
	const withoutAt = value.slice(1);
	const splitIndex = withoutAt.indexOf(":");
	if (splitIndex === -1) return value.toLowerCase();
	const localpart = withoutAt.slice(0, splitIndex).toLowerCase();
	const server = withoutAt.slice(splitIndex + 1).toLowerCase();
	if (!server) return value.toLowerCase();
	return `@${localpart}:${server.toLowerCase()}`;
}
function normalizeMatrixUserId(raw) {
	const trimmed = (raw ?? "").trim();
	if (!trimmed) return "";
	const lowered = trimmed.toLowerCase();
	if (lowered.startsWith("matrix:")) return normalizeMatrixUser(trimmed.slice(7));
	if (lowered.startsWith("user:")) return normalizeMatrixUser(trimmed.slice(5));
	return normalizeMatrixUser(trimmed);
}
function normalizeMatrixAllowListEntry(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	if (trimmed === "*") return trimmed;
	const lowered = trimmed.toLowerCase();
	if (lowered.startsWith("matrix:")) return `matrix:${normalizeMatrixUser(trimmed.slice(7))}`;
	if (lowered.startsWith("user:")) return `user:${normalizeMatrixUser(trimmed.slice(5))}`;
	return normalizeMatrixUser(trimmed);
}
function normalizeMatrixAllowList(list) {
	return normalizeAllowList(list).map((entry) => normalizeMatrixAllowListEntry(entry));
}
function resolveMatrixAllowListMatch(params) {
	const compiledAllowList = compileAllowlist(params.allowList);
	const userId = normalizeMatrixUser(params.userId);
	return resolveCompiledAllowlistMatch({
		compiledAllowlist: compiledAllowList,
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
function resolveMatrixAllowListMatches(params) {
	return resolveMatrixAllowListMatch(params).allowed;
}
//#endregion
//#region extensions/matrix/src/matrix/actions/types.ts
const MsgType = { Text: "m.text" };
const RelationType = {
	Replace: "m.replace",
	Annotation: "m.annotation"
};
const EventType = {
	RoomMessage: "m.room.message",
	RoomPinnedEvents: "m.room.pinned_events",
	RoomTopic: "m.room.topic",
	Reaction: "m.reaction"
};
//#endregion
//#region extensions/matrix/src/matrix/actions/summary.ts
function summarizeMatrixRawEvent(event) {
	const content = event.content;
	const relates = content["m.relates_to"];
	let relType;
	let eventId;
	if (relates) {
		if ("rel_type" in relates) {
			relType = relates.rel_type;
			eventId = relates.event_id;
		} else if ("m.in_reply_to" in relates) eventId = relates["m.in_reply_to"]?.event_id;
	}
	const relatesTo = relType || eventId ? {
		relType,
		eventId
	} : void 0;
	return {
		eventId: event.event_id,
		sender: event.sender,
		body: content.body,
		msgtype: content.msgtype,
		timestamp: event.origin_server_ts,
		relatesTo
	};
}
async function readPinnedEvents(client, roomId) {
	try {
		return (await client.getRoomStateEvent(roomId, EventType.RoomPinnedEvents, "")).pinned.filter((id) => id.trim().length > 0);
	} catch (err) {
		const errObj = err;
		const httpStatus = errObj.statusCode;
		const errcode = errObj.body?.errcode;
		if (httpStatus === 404 || errcode === "M_NOT_FOUND") return [];
		throw err;
	}
}
async function fetchEventSummary(client, roomId, eventId) {
	try {
		const raw = await client.getEvent(roomId, eventId);
		if (raw.unsigned?.redacted_because) return null;
		return summarizeMatrixRawEvent(raw);
	} catch {
		return null;
	}
}
//#endregion
//#region extensions/matrix/src/matrix/monitor/rooms.ts
function resolveMatrixRoomConfig(params) {
	const rooms = params.rooms ?? {};
	const allowlistConfigured = Object.keys(rooms).length > 0;
	const { entry: matched, key: matchedKey, wildcardEntry, wildcardKey } = resolveChannelEntryMatch({
		entries: rooms,
		keys: buildChannelKeyCandidates(params.roomId, `room:${params.roomId}`, ...params.aliases),
		wildcardKey: "*"
	});
	const resolved = matched ?? wildcardEntry;
	return {
		allowed: resolved ? resolved.enabled !== false && resolved.allow !== false : false,
		allowlistConfigured,
		config: resolved,
		matchKey: matchedKey ?? wildcardKey,
		matchSource: matched ? "direct" : wildcardEntry ? "wildcard" : void 0
	};
}
//#endregion
export { EventType as a, normalizeMatrixAllowList as c, resolveMatrixAllowListMatches as d, summarizeMatrixRawEvent as i, normalizeMatrixUserId as l, fetchEventSummary as n, MsgType as o, readPinnedEvents as r, RelationType as s, resolveMatrixRoomConfig as t, resolveMatrixAllowListMatch as u };
