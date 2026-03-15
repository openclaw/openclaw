import { Br as generatePairingToken, Ur as pruneExpiredPending, Vr as verifyPairingToken, Wr as resolvePairingPaths } from "./auth-profiles-DqxBs6Au.js";
import { n as readJsonFile, r as writeJsonAtomic, t as createAsyncLock } from "./json-files-DTtlIKNR.js";
import path from "node:path";
//#region src/infra/device-bootstrap.ts
const DEVICE_BOOTSTRAP_TOKEN_TTL_MS = 600 * 1e3;
const withLock = createAsyncLock();
function resolveBootstrapPath(baseDir) {
	return path.join(resolvePairingPaths(baseDir, "devices").dir, "bootstrap.json");
}
async function loadState(baseDir) {
	const rawState = await readJsonFile(resolveBootstrapPath(baseDir)) ?? {};
	const state = {};
	if (!rawState || typeof rawState !== "object" || Array.isArray(rawState)) {return state;}
	for (const [tokenKey, entry] of Object.entries(rawState)) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {continue;}
		const record = entry;
		const token = typeof record.token === "string" && record.token.trim().length > 0 ? record.token : tokenKey;
		const issuedAtMs = typeof record.issuedAtMs === "number" ? record.issuedAtMs : 0;
		state[tokenKey] = {
			...record,
			token,
			issuedAtMs,
			ts: typeof record.ts === "number" ? record.ts : issuedAtMs
		};
	}
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
		if (!providedToken) {return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};}
		const entry = Object.values(state).find((candidate) => verifyPairingToken(providedToken, candidate.token));
		if (!entry) {return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};}
		const deviceId = params.deviceId.trim();
		const publicKey = params.publicKey.trim();
		const role = params.role.trim();
		if (!deviceId || !publicKey || !role) {return {
			ok: false,
			reason: "bootstrap_token_invalid"
		};}
		delete state[entry.token];
		await persistState(state, params.baseDir);
		return { ok: true };
	});
}
//#endregion
export { verifyDeviceBootstrapToken as n, issueDeviceBootstrapToken as t };
