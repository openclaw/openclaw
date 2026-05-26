import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { t as KeyedAsyncQueue } from "./keyed-async-queue-CBv-Vhmc.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { t as isMatrixQualifiedUserId } from "./target-ids-CPjRklwl.js";
import { n as MATRIX_REACTION_EVENT_TYPE, t as MATRIX_ANNOTATION_RELATION_TYPE } from "./reaction-common-BjAtJ4Dp.js";
import { n as inspectMatrixDirectRoomEvidence } from "./direct-room-BifRU7rS.js";
//#region extensions/matrix/src/matrix/send/types.ts
const MsgType = {
	Text: "m.text",
	Image: "m.image",
	Audio: "m.audio",
	Video: "m.video",
	File: "m.file",
	Notice: "m.notice"
};
const RelationType = {
	Annotation: MATRIX_ANNOTATION_RELATION_TYPE,
	Replace: "m.replace",
	Thread: "m.thread"
};
const EventType = {
	Direct: "m.direct",
	Reaction: MATRIX_REACTION_EVENT_TYPE,
	RoomMessage: "m.room.message"
};
const MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY = "com.openclaw.finalized_preview";
/**
* MSC4357 live marker key.
* When present on event content, signals that the message is still being
* streamed (e.g. an LLM generating a response). Supporting clients render
* the message with a streaming animation until an edit without this marker
* arrives, indicating the stream is complete.
* @see https://github.com/matrix-org/matrix-spec-proposals/pull/4357
*/
const MSC4357_LIVE_KEY = "org.matrix.msc4357.live";
//#endregion
//#region extensions/matrix/src/matrix/direct-management.ts
const DIRECT_ACCOUNT_DATA_QUEUE_KEY = EventType.Direct;
const directAccountDataWriteQueues = /* @__PURE__ */ new WeakMap();
async function readMatrixDirectAccountData(client) {
	try {
		const direct = await client.getAccountData(EventType.Direct);
		return direct && typeof direct === "object" && !Array.isArray(direct) ? direct : {};
	} catch {
		return {};
	}
}
function normalizeRemoteUserId(remoteUserId) {
	const normalized = normalizeOptionalString(remoteUserId) ?? "";
	if (!isMatrixQualifiedUserId(normalized)) throw new Error(`Matrix user IDs must be fully qualified (got "${remoteUserId}")`);
	return normalized;
}
function normalizeMappedRoomIds(direct, remoteUserId) {
	const current = direct[remoteUserId];
	if (!Array.isArray(current)) return [];
	const seen = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const value of current) {
		const roomId = normalizeOptionalString(value) ?? "";
		if (!roomId || seen.has(roomId)) continue;
		seen.add(roomId);
		normalized.push(roomId);
	}
	return normalized;
}
function normalizeRoomIdList(values) {
	const seen = /* @__PURE__ */ new Set();
	const normalized = [];
	for (const value of values) {
		const roomId = value.trim();
		if (!roomId || seen.has(roomId)) continue;
		seen.add(roomId);
		normalized.push(roomId);
	}
	return normalized;
}
function hasMatrixDirectRoomMappings(params) {
	const current = normalizeMappedRoomIds(params.directContent, params.remoteUserId);
	const next = normalizeRoomIdList([...params.roomIds, ...current]);
	return current.length === next.length && current.every((roomId, index) => roomId === next[index]);
}
function resolveDirectAccountDataWriteQueue(client) {
	const existing = directAccountDataWriteQueues.get(client);
	if (existing) return existing;
	const created = new KeyedAsyncQueue();
	directAccountDataWriteQueues.set(client, created);
	return created;
}
async function writeMatrixDirectRoomMappings(params) {
	return await resolveDirectAccountDataWriteQueue(params.client).enqueue(DIRECT_ACCOUNT_DATA_QUEUE_KEY, async () => {
		const directContentBefore = await readMatrixDirectAccountData(params.client);
		const directContentAfter = buildNextDirectContent({
			directContent: directContentBefore,
			remoteUserId: params.remoteUserId,
			roomIds: params.roomIds
		});
		const changed = !hasMatrixDirectRoomMappings({
			directContent: directContentBefore,
			remoteUserId: params.remoteUserId,
			roomIds: params.roomIds
		});
		if (changed) await params.client.setAccountData(EventType.Direct, directContentAfter);
		return {
			changed,
			directContentBefore,
			directContentAfter
		};
	});
}
async function classifyDirectRoomCandidate(params) {
	const evidence = await inspectMatrixDirectRoomEvidence({
		client: params.client,
		roomId: params.roomId,
		remoteUserId: params.remoteUserId,
		selfUserId: params.selfUserId
	});
	return {
		roomId: params.roomId,
		joinedMembers: evidence.joinedMembers,
		strict: evidence.strict && (params.source === "account-data" || evidence.memberStateFlag !== false),
		explicit: evidence.strict && (params.source === "account-data" || evidence.memberStateFlag !== false) && (params.source === "account-data" || evidence.viaMemberState),
		source: params.source
	};
}
function buildNextDirectContent(params) {
	const current = normalizeMappedRoomIds(params.directContent, params.remoteUserId);
	const nextRooms = normalizeRoomIdList([...params.roomIds, ...current]);
	return {
		...params.directContent,
		[params.remoteUserId]: nextRooms
	};
}
async function persistMatrixDirectRoomMapping(params) {
	const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
	return (await writeMatrixDirectRoomMappings({
		client: params.client,
		remoteUserId,
		roomIds: [params.roomId]
	})).changed;
}
async function promoteMatrixDirectRoomCandidate(params) {
	const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
	const evidence = await inspectMatrixDirectRoomEvidence({
		client: params.client,
		roomId: params.roomId,
		remoteUserId,
		selfUserId: params.selfUserId
	});
	if (!evidence.strict) return {
		classifyAsDirect: false,
		repaired: false,
		reason: "not-strict"
	};
	if (evidence.memberStateFlag === false) return {
		classifyAsDirect: false,
		repaired: false,
		reason: "local-explicit-false"
	};
	try {
		const repaired = await persistMatrixDirectRoomMapping({
			client: params.client,
			remoteUserId,
			roomId: params.roomId
		});
		return {
			classifyAsDirect: true,
			repaired,
			roomId: params.roomId,
			reason: repaired ? "promoted" : "already-mapped"
		};
	} catch {
		return {
			classifyAsDirect: true,
			repaired: false,
			roomId: params.roomId,
			reason: "repair-failed"
		};
	}
}
async function inspectMatrixDirectRooms(params) {
	const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
	const selfUserId = normalizeOptionalString(await params.client.getUserId().catch(() => null)) ?? null;
	const mappedRoomIds = normalizeMappedRoomIds(await readMatrixDirectAccountData(params.client), remoteUserId);
	const mappedRooms = await Promise.all(mappedRoomIds.map(async (roomId) => await classifyDirectRoomCandidate({
		client: params.client,
		roomId,
		remoteUserId,
		selfUserId,
		source: "account-data"
	})));
	const mappedStrict = mappedRooms.find((room) => room.strict);
	let joinedRooms = [];
	if (typeof params.client.getJoinedRooms === "function") try {
		const resolved = await params.client.getJoinedRooms();
		joinedRooms = Array.isArray(resolved) ? resolved : [];
	} catch {
		joinedRooms = [];
	}
	const discoveredStrictRooms = [];
	for (const roomId of normalizeRoomIdList(joinedRooms)) {
		if (mappedRoomIds.includes(roomId)) continue;
		const candidate = await classifyDirectRoomCandidate({
			client: params.client,
			roomId,
			remoteUserId,
			selfUserId,
			source: "joined"
		});
		if (candidate.strict) discoveredStrictRooms.push(candidate);
	}
	const discoveredStrictRoomIds = discoveredStrictRooms.map((room) => room.roomId);
	const discoveredExplicit = discoveredStrictRooms.find((room) => room.explicit);
	return {
		selfUserId,
		remoteUserId,
		mappedRoomIds,
		mappedRooms,
		discoveredStrictRoomIds,
		activeRoomId: mappedStrict?.roomId ?? discoveredExplicit?.roomId ?? discoveredStrictRoomIds[0] ?? null
	};
}
async function repairMatrixDirectRooms(params) {
	const remoteUserId = normalizeRemoteUserId(params.remoteUserId);
	const inspected = await inspectMatrixDirectRooms({
		client: params.client,
		remoteUserId
	});
	const activeRoomId = inspected.activeRoomId ?? await params.client.createDirectRoom(remoteUserId, { encrypted: params.encrypted === true });
	const createdRoomId = inspected.activeRoomId ? null : activeRoomId;
	const mappingWrite = await writeMatrixDirectRoomMappings({
		client: params.client,
		remoteUserId,
		roomIds: [activeRoomId, ...inspected.discoveredStrictRoomIds]
	});
	return {
		...inspected,
		activeRoomId,
		createdRoomId,
		changed: mappingWrite.changed,
		directContentBefore: mappingWrite.directContentBefore,
		directContentAfter: mappingWrite.directContentAfter
	};
}
//#endregion
export { EventType as a, MsgType as c, repairMatrixDirectRooms as i, RelationType as l, persistMatrixDirectRoomMapping as n, MATRIX_OPENCLAW_FINALIZED_PREVIEW_KEY as o, promoteMatrixDirectRoomCandidate as r, MSC4357_LIVE_KEY as s, inspectMatrixDirectRooms as t };
