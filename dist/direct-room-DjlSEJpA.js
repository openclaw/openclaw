//#region extensions/matrix/src/matrix/direct-room.ts
function trimMaybeString(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}
function normalizeJoinedMatrixMembers(joinedMembers) {
	if (!Array.isArray(joinedMembers)) return [];
	return joinedMembers.map((entry) => trimMaybeString(entry)).filter((entry) => Boolean(entry));
}
function isStrictDirectMembership(params) {
	const selfUserId = trimMaybeString(params.selfUserId);
	const remoteUserId = trimMaybeString(params.remoteUserId);
	const joinedMembers = params.joinedMembers ?? [];
	return Boolean(selfUserId && remoteUserId && joinedMembers.length === 2 && joinedMembers.includes(selfUserId) && joinedMembers.includes(remoteUserId));
}
async function readJoinedMatrixMembers(client, roomId) {
	try {
		return normalizeJoinedMatrixMembers(await client.getJoinedRoomMembers(roomId));
	} catch {
		return null;
	}
}
async function hasDirectMatrixMemberFlag(client, roomId, userId) {
	const normalizedUserId = trimMaybeString(userId);
	if (!normalizedUserId) return null;
	try {
		const state = await client.getRoomStateEvent(roomId, "m.room.member", normalizedUserId);
		if (state?.is_direct === true) return true;
		if (state?.is_direct === false) return false;
		return null;
	} catch {
		return null;
	}
}
async function inspectMatrixDirectRoomEvidence(params) {
	const selfUserId = params.selfUserId !== void 0 ? trimMaybeString(params.selfUserId) : trimMaybeString(await params.client.getUserId().catch(() => null));
	const joinedMembers = await readJoinedMatrixMembers(params.client, params.roomId);
	const strict = isStrictDirectMembership({
		selfUserId,
		remoteUserId: params.remoteUserId,
		joinedMembers
	});
	if (!strict) return {
		joinedMembers,
		strict: false,
		viaMemberState: false,
		memberStateFlag: null
	};
	const memberStateFlag = await hasDirectMatrixMemberFlag(params.client, params.roomId, selfUserId);
	return {
		joinedMembers,
		strict,
		viaMemberState: memberStateFlag === true,
		memberStateFlag
	};
}
async function isStrictDirectRoom(params) {
	return (await inspectMatrixDirectRoomEvidence({
		client: params.client,
		roomId: params.roomId,
		remoteUserId: params.remoteUserId,
		selfUserId: params.selfUserId
	})).strict;
}
//#endregion
export { normalizeJoinedMatrixMembers as a, isStrictDirectRoom as i, inspectMatrixDirectRoomEvidence as n, readJoinedMatrixMembers as o, isStrictDirectMembership as r, hasDirectMatrixMemberFlag as t };
