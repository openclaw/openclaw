import { u as resolveMatrixRoomId } from "./send-BByS3H9Q.js";
import { r as withResolvedRuntimeMatrixClient } from "./client-bootstrap-DL1iP9ia.js";
//#region extensions/matrix/src/matrix/actions/client.ts
async function withResolvedActionClient(opts, run, mode = "stop") {
	return await withResolvedRuntimeMatrixClient(opts, run, mode);
}
async function withStartedActionClient(opts, run) {
	return await withResolvedActionClient({
		...opts,
		readiness: "started"
	}, run, "persist");
}
async function withResolvedRoomAction(roomId, opts, run) {
	return await withResolvedActionClient(opts, async (client) => {
		return await run(client, await resolveMatrixRoomId(client, roomId));
	});
}
//#endregion
export { withResolvedRoomAction as n, withStartedActionClient as r, withResolvedActionClient as t };
