import { g as resolveStateDir } from "./paths-BBP4yd-2.js";
import { t as safeEqualSecret } from "./secret-equal-B7oJEPub.js";
import path from "node:path";
import { randomBytes } from "node:crypto";

//#region src/infra/pairing-files.ts
function resolvePairingPaths(baseDir, subdir) {
	const root = baseDir ?? resolveStateDir();
	const dir = path.join(root, subdir);
	return {
		dir,
		pendingPath: path.join(dir, "pending.json"),
		pairedPath: path.join(dir, "paired.json")
	};
}
function pruneExpiredPending(pendingById, nowMs, ttlMs) {
	for (const [id, req] of Object.entries(pendingById)) if (nowMs - req.ts > ttlMs) delete pendingById[id];
}
async function upsertPendingPairingRequest(params) {
	const existing = Object.values(params.pendingById).find(params.isExisting);
	if (existing) return {
		status: "pending",
		request: existing,
		created: false
	};
	const request = params.createRequest(params.isRepair);
	params.pendingById[request.requestId] = request;
	await params.persist();
	return {
		status: "pending",
		request,
		created: true
	};
}

//#endregion
//#region src/infra/pairing-pending.ts
async function rejectPendingPairingRequest(params) {
	const state = await params.loadState();
	const pending = state.pendingById[params.requestId];
	if (!pending) return null;
	delete state.pendingById[params.requestId];
	await params.persistState(state);
	return {
		requestId: params.requestId,
		[params.idKey]: params.getId(pending)
	};
}

//#endregion
//#region src/infra/pairing-token.ts
const PAIRING_TOKEN_BYTES = 32;
function generatePairingToken() {
	return randomBytes(PAIRING_TOKEN_BYTES).toString("base64url");
}
function verifyPairingToken(provided, expected) {
	return safeEqualSecret(provided, expected);
}

//#endregion
export { resolvePairingPaths as a, pruneExpiredPending as i, verifyPairingToken as n, upsertPendingPairingRequest as o, rejectPendingPairingRequest as r, generatePairingToken as t };