import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as normalizeMatrixMessagingTarget, t as isMatrixQualifiedUserId } from "./target-ids-CPjRklwl.js";
import { t as MatrixAuthedHttpClient } from "./http-client-C-kvVjHY.js";
import { n as resolveMatrixAuth } from "./config-zGJE8Xzj.js";
import "./client-DDhjrzng.js";
//#region extensions/matrix/src/directory-live.ts
const MATRIX_DIRECTORY_TIMEOUT_MS = 1e4;
function resolveMatrixDirectoryLimit(limit) {
	return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : 20;
}
function createMatrixDirectoryClient(auth) {
	return new MatrixAuthedHttpClient({
		homeserver: auth.homeserver,
		accessToken: auth.accessToken,
		ssrfPolicy: auth.ssrfPolicy,
		dispatcherPolicy: auth.dispatcherPolicy
	});
}
async function resolveMatrixDirectoryContext(params) {
	const query = normalizeOptionalString(params.query) ?? "";
	if (!query) return null;
	const auth = await resolveMatrixAuth({
		cfg: params.cfg,
		accountId: params.accountId
	});
	return {
		auth,
		client: createMatrixDirectoryClient(auth),
		query,
		queryLower: normalizeLowercaseStringOrEmpty(query)
	};
}
function createGroupDirectoryEntry(params) {
	return {
		kind: "group",
		id: params.id,
		name: params.name,
		handle: params.handle
	};
}
async function requestMatrixJson(client, params) {
	return await client.requestJson({
		method: params.method,
		endpoint: params.endpoint,
		body: params.body,
		timeoutMs: MATRIX_DIRECTORY_TIMEOUT_MS
	});
}
async function listMatrixDirectoryPeersLive(params) {
	const query = normalizeOptionalString(params.query) ?? "";
	if (!query) return [];
	const directUserId = normalizeMatrixMessagingTarget(query);
	if (directUserId && isMatrixQualifiedUserId(directUserId)) return [{
		kind: "user",
		id: directUserId
	}];
	const context = await resolveMatrixDirectoryContext({
		...params,
		query
	});
	if (!context) return [];
	return ((await requestMatrixJson(context.client, {
		method: "POST",
		endpoint: "/_matrix/client/v3/user_directory/search",
		body: {
			search_term: context.query,
			limit: resolveMatrixDirectoryLimit(params.limit)
		}
	})).results ?? []).map((entry) => {
		const userId = normalizeOptionalString(entry.user_id);
		if (!userId) return null;
		const displayName = normalizeOptionalString(entry.display_name);
		return {
			kind: "user",
			id: userId,
			name: displayName,
			handle: displayName ? `@${displayName}` : void 0,
			raw: entry
		};
	}).filter(Boolean);
}
async function resolveMatrixRoomAlias(client, alias) {
	try {
		return normalizeOptionalString((await requestMatrixJson(client, {
			method: "GET",
			endpoint: `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`
		})).room_id) ?? null;
	} catch {
		return null;
	}
}
async function fetchMatrixRoomName(client, roomId) {
	try {
		return normalizeOptionalString((await requestMatrixJson(client, {
			method: "GET",
			endpoint: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`
		})).name) ?? null;
	} catch {
		return null;
	}
}
async function listMatrixDirectoryGroupsLive(params) {
	const query = normalizeOptionalString(params.query) ?? "";
	if (!query) return [];
	const directTarget = normalizeMatrixMessagingTarget(query);
	if (directTarget?.startsWith("!")) return [createGroupDirectoryEntry({
		id: directTarget,
		name: directTarget
	})];
	const context = await resolveMatrixDirectoryContext({
		...params,
		query
	});
	if (!context) return [];
	const { client, queryLower } = context;
	const limit = resolveMatrixDirectoryLimit(params.limit);
	if (directTarget?.startsWith("#")) {
		const roomId = await resolveMatrixRoomAlias(client, directTarget);
		if (!roomId) return [];
		return [createGroupDirectoryEntry({
			id: roomId,
			name: directTarget,
			handle: directTarget
		})];
	}
	const rooms = ((await requestMatrixJson(client, {
		method: "GET",
		endpoint: "/_matrix/client/v3/joined_rooms"
	})).joined_rooms ?? []).map((roomId) => normalizeOptionalString(roomId)).filter((roomId) => Boolean(roomId));
	const results = [];
	for (const roomId of rooms) {
		const name = await fetchMatrixRoomName(client, roomId);
		if (!name || !normalizeLowercaseStringOrEmpty(name).includes(queryLower)) continue;
		results.push({
			kind: "group",
			id: roomId,
			name,
			handle: `#${name}`
		});
		if (results.length >= limit) break;
	}
	return results;
}
//#endregion
export { listMatrixDirectoryPeersLive as n, listMatrixDirectoryGroupsLive as t };
