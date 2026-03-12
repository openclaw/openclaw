import { g as resolveStateDir } from "./paths-B4BZAPZh.js";
import { t as safeEqualSecret } from "./secret-equal-CQn9WoXt.js";
import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";

//#region src/infra/json-files.ts
async function readJsonFile(filePath) {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}
async function writeJsonAtomic(filePath, value, options) {
	const mode = options?.mode ?? 384;
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${filePath}.${randomUUID()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
	try {
		await fs.chmod(tmp, mode);
	} catch {}
	await fs.rename(tmp, filePath);
	try {
		await fs.chmod(filePath, mode);
	} catch {}
}
function createAsyncLock() {
	let lock = Promise.resolve();
	return async function withLock(fn) {
		const prev = lock;
		let release;
		lock = new Promise((resolve) => {
			release = resolve;
		});
		await prev;
		try {
			return await fn();
		} finally {
			release?.();
		}
	};
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
export { resolvePairingPaths as a, readJsonFile as c, pruneExpiredPending as i, writeJsonAtomic as l, verifyPairingToken as n, upsertPendingPairingRequest as o, rejectPendingPairingRequest as r, createAsyncLock as s, generatePairingToken as t };