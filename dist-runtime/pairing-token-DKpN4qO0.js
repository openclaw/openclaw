import { c as resolveStateDir } from "./paths-Byjx7_T6.js";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
//#region src/security/secret-equal.ts
function safeEqualSecret(provided, expected) {
	if (typeof provided !== "string" || typeof expected !== "string") {return false;}
	const hash = (s) => createHash("sha256").update(s).digest();
	return timingSafeEqual(hash(provided), hash(expected));
}
//#endregion
//#region src/shared/device-auth.ts
function normalizeDeviceAuthRole(role) {
	return role.trim();
}
function normalizeDeviceAuthScopes(scopes) {
	if (!Array.isArray(scopes)) {return [];}
	const out = /* @__PURE__ */ new Set();
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) {out.add(trimmed);}
	}
	return [...out].toSorted();
}
//#endregion
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
	for (const [id, req] of Object.entries(pendingById)) {if (nowMs - req.ts > ttlMs) delete pendingById[id];}
}
function generatePairingToken() {
	return randomBytes(32).toString("base64url");
}
//#endregion
export { normalizeDeviceAuthScopes as a, normalizeDeviceAuthRole as i, pruneExpiredPending as n, safeEqualSecret as o, resolvePairingPaths as r, generatePairingToken as t };
