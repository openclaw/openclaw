import "./logger-DEV1v8zB.js";
import "./tmp-openclaw-dir-DGafsubg.js";
import "./subsystem-BunQspj4.js";
import { n as readJsonFile, r as writeJsonAtomic, t as createAsyncLock } from "./json-files-D9UnRp_W.js";
import "./exec-LHBFP7K9.js";
import "./logger-kC9I1OJ3.js";
import { i as resolvePairingPaths, r as pruneExpiredPending, t as generatePairingToken } from "./pairing-token-BUkoGEse.js";
import { t as runPluginCommandWithTimeout } from "./run-command-Z5uOHylE.js";
import { n as resolveGatewayBindUrl, t as resolveTailnetHostWithRunner } from "./tailscale-status-BYbEMheb.js";
import { n as listDevicePairing, t as approveDevicePairing } from "./device-pairing-cTvIZwx2.js";
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
//#endregion
export { approveDevicePairing, issueDeviceBootstrapToken, listDevicePairing, resolveGatewayBindUrl, resolveTailnetHostWithRunner, runPluginCommandWithTimeout };
