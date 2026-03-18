import { O as resolveStateDir, S as init_paths } from "./logger-D1gzveLR.js";
import { n as init_json_files } from "./json-files-DFquuRAh.js";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
//#region src/security/secret-equal.ts
function safeEqualSecret(provided, expected) {
	if (typeof provided !== "string" || typeof expected !== "string") return false;
	const hash = (s) => createHash("sha256").update(s).digest();
	return timingSafeEqual(hash(provided), hash(expected));
}
//#endregion
//#region src/shared/device-auth.ts
function normalizeDeviceAuthRole(role) {
	return role.trim();
}
function normalizeDeviceAuthScopes(scopes) {
	if (!Array.isArray(scopes)) return [];
	const out = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) out.add(trimmed);
	}
	return [...out].toSorted();
}
//#endregion
//#region src/infra/pairing-files.ts
init_paths();
init_json_files();
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
function generatePairingToken() {
	return randomBytes(32).toString("base64url");
}
//#endregion
export { normalizeDeviceAuthRole as a, resolvePairingPaths as i, rejectPendingPairingRequest as n, normalizeDeviceAuthScopes as o, pruneExpiredPending as r, safeEqualSecret as s, generatePairingToken as t };
