import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isMatrixNotFoundError } from "./errors-Cd21tNWv.js";
import { a as sendMessageMatrix, h as isPollEventType, n as editMessageMatrix } from "./send-xdKxcj70.js";
import { n as MATRIX_REACTION_EVENT_TYPE } from "./reaction-common-BjAtJ4Dp.js";
import { a as resolveMatrixMessageBody, c as resolveMatrixPollRootEventId, i as resolveMatrixMessageAttachment, o as fetchMatrixPollMessageSummary } from "./media-text-CA7sPPkB.js";
import { n as withResolvedRoomAction } from "./client-CWBVxcE6.js";
//#region extensions/matrix/src/matrix/actions/limits.ts
function resolveMatrixActionLimit(raw, fallback) {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
	return Math.max(1, Math.floor(raw));
}
//#endregion
//#region extensions/matrix/src/matrix/actions/types.ts
const EventType = {
	RoomMessage: "m.room.message",
	RoomPinnedEvents: "m.room.pinned_events",
	RoomTopic: "m.room.topic",
	Reaction: MATRIX_REACTION_EVENT_TYPE
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
		body: resolveMatrixMessageBody({
			body: content.body,
			filename: content.filename,
			msgtype: content.msgtype
		}),
		msgtype: content.msgtype,
		attachment: resolveMatrixMessageAttachment({
			body: content.body,
			filename: content.filename,
			msgtype: content.msgtype
		}),
		timestamp: event.origin_server_ts,
		relatesTo
	};
}
async function readPinnedEvents(client, roomId) {
	try {
		return (await client.getRoomStateEvent(roomId, EventType.RoomPinnedEvents, "")).pinned.filter((id) => id.trim().length > 0);
	} catch (err) {
		if (isMatrixNotFoundError(err)) return [];
		throw err;
	}
}
async function fetchEventSummary(client, roomId, eventId) {
	try {
		const raw = await client.getEvent(roomId, eventId);
		if (raw.unsigned?.redacted_because) return null;
		const pollSummary = await fetchMatrixPollMessageSummary(client, roomId, raw);
		if (pollSummary) return pollSummary;
		return summarizeMatrixRawEvent(raw);
	} catch {
		return null;
	}
}
//#endregion
//#region extensions/matrix/src/matrix/actions/messages.ts
async function sendMatrixMessage(to, content, opts = {}) {
	if (!opts.cfg) throw new Error("Matrix message actions require a resolved runtime config.");
	return await sendMessageMatrix(to, content, {
		cfg: opts.cfg,
		mediaUrl: opts.mediaUrl,
		mediaLocalRoots: opts.mediaLocalRoots,
		replyToId: opts.replyToId,
		threadId: opts.threadId,
		audioAsVoice: opts.audioAsVoice,
		accountId: opts.accountId ?? void 0,
		client: opts.client,
		timeoutMs: opts.timeoutMs
	});
}
async function editMatrixMessage(roomId, messageId, content, opts = {}) {
	if (!opts.cfg) throw new Error("Matrix message actions require a resolved runtime config.");
	const trimmed = content.trim();
	if (!trimmed) throw new Error("Matrix edit requires content");
	return { eventId: await editMessageMatrix(roomId, messageId, trimmed, {
		cfg: opts.cfg,
		accountId: opts.accountId ?? void 0,
		client: opts.client,
		timeoutMs: opts.timeoutMs
	}) || null };
}
async function deleteMatrixMessage(roomId, messageId, opts = {}) {
	await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		await client.redactEvent(resolvedRoom, messageId, opts.reason);
	});
}
async function readMatrixMessages(roomId, opts = {}) {
	return await withResolvedRoomAction(roomId, opts, async (client, resolvedRoom) => {
		const limit = resolveMatrixActionLimit(opts.limit, 20);
		const token = normalizeOptionalString(opts.before) ?? normalizeOptionalString(opts.after);
		const dir = opts.after ? "f" : "b";
		const res = await client.doRequest("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(resolvedRoom)}/messages`, {
			dir,
			limit,
			from: token
		});
		const hydratedChunk = await client.hydrateEvents(resolvedRoom, res.chunk);
		const seenPollRoots = /* @__PURE__ */ new Set();
		const messages = [];
		for (const event of hydratedChunk) {
			if (event.unsigned?.redacted_because) continue;
			if (event.type === EventType.RoomMessage) {
				messages.push(summarizeMatrixRawEvent(event));
				continue;
			}
			if (!isPollEventType(event.type)) continue;
			const pollRootId = resolveMatrixPollRootEventId(event);
			if (!pollRootId || seenPollRoots.has(pollRootId)) continue;
			seenPollRoots.add(pollRootId);
			const pollSummary = await fetchMatrixPollMessageSummary(client, resolvedRoom, event);
			if (pollSummary) messages.push(pollSummary);
		}
		return {
			messages,
			nextBatch: res.end ?? null,
			prevBatch: res.start ?? null
		};
	});
}
//#endregion
export { fetchEventSummary as a, resolveMatrixActionLimit as c, sendMatrixMessage as i, editMatrixMessage as n, readPinnedEvents as o, readMatrixMessages as r, EventType as s, deleteMatrixMessage as t };
