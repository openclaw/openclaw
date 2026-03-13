import { Lm as createAsyncLock, Rm as readJsonFile, ln as pruneExpiredPending, on as generatePairingToken, sn as verifyPairingToken, un as resolvePairingPaths, zm as writeJsonAtomic } from "./reply-kqyKJg4x.js";
import path from "node:path";
//#region src/infra/device-bootstrap.ts
const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 600 * 1e3;
const withLock = createAsyncLock();
function mergeRoles(existing, role) {
	const out = new Set(existing ?? []);
	const trimmed = role.trim();
	if (trimmed) out.add(trimmed);
	return [...out];
}
function mergeScopes(existing, scopes) {
	const out = new Set(existing ?? []);
	for (const scope of scopes) {
		const trimmed = scope.trim();
		if (trimmed) out.add(trimmed);
	}
	return out.size > 0 ? [...out] : void 0;
}
function resolveBootstrapPath(baseDir) {
	return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}
async function loadState(baseDir) {
	const state = await readJsonFile(resolveBootstrapPath(baseDir)) ?? {};
	for (const entry of Object.values(state)) if (typeof entry.ts !== "number") entry.ts = entry.issuedAtMs;
	pruneExpiredPending(state, Date.now(), DEVICE_BOOTSTRAP_TOKEN_TTL_MS);
	return state;
}
async function persistState(state, baseDir) {
	await writeJsonAtomic(resolveBootstrapPath(baseDir), state);
}
async function issueDeviceBootstrapToken(params = {}) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const token = generatePairingToken();
		const issuedAtMs = Date.now();
		state[token] = {
			token,
			ts: issuedAtMs,
			issuedAtMs
		};
		await persistState(state, params.baseDir);
		return {
			token,
			expiresAtMs: issuedAtMs + DEVICE_BOOTSTRAP_TOKEN_TTL_MS
		};
	});
}
async function verifyDeviceBootstrapToken(params) {
	return await withLock(async () => {
		const state = await loadState(params.baseDir);
		const providedToken = params.token.trim();
		if (!providedToken) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		const entry = Object.values(state).find((candidate) => verifyPairingToken(providedToken, candidate.token));
		if (!entry) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		const deviceId = params.deviceId.trim();
		const publicKey = params.publicKey.trim();
		const role = params.role.trim();
		if (!deviceId || !publicKey || !role) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		if (entry.deviceId && entry.deviceId !== deviceId) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		if (entry.publicKey && entry.publicKey !== publicKey) return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};
		entry.deviceId = deviceId;
		entry.publicKey = publicKey;
		entry.roles = mergeRoles(entry.roles, role);
		entry.scopes = mergeScopes(entry.scopes, params.scopes);
		entry.lastUsedAtMs = Date.now();
		state[entry.token] = entry;
		await persistState(state, params.baseDir);
		return { ok: true };
	});
}
//#endregion
export { verifyDeviceBootstrapToken as n, issueDeviceBootstrapToken as t };
