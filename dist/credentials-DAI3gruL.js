import { i as writeJsonFileAtomically } from "./json-store-ChgPP2Sf.js";
import { a as resolveMatrixCredentialsPath, i as resolveMatrixCredentialsDir, n as credentialsMatchConfig, r as loadMatrixCredentials, t as clearMatrixCredentials } from "./credentials-read-CCifjupZ.js";
import { t as createAsyncLock } from "./async-lock-BcLS4KOc.js";
//#region extensions/matrix/src/matrix/credentials.ts
const credentialWriteLocks = /* @__PURE__ */ new Map();
function withCredentialWriteLock(credPath, fn) {
	let withLock = credentialWriteLocks.get(credPath);
	if (!withLock) {
		withLock = createAsyncLock();
		credentialWriteLocks.set(credPath, withLock);
	}
	return withLock(fn);
}
async function writeMatrixCredentialsUnlocked(params) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const toSave = {
		...params.credentials,
		createdAt: params.existing?.createdAt ?? now,
		lastUsedAt: now
	};
	await writeJsonFileAtomically(params.credPath, toSave);
}
async function saveMatrixCredentials(credentials, env = process.env, accountId) {
	const credPath = resolveMatrixCredentialsPath(env, accountId);
	await withCredentialWriteLock(credPath, async () => {
		await writeMatrixCredentialsUnlocked({
			credPath,
			credentials,
			existing: loadMatrixCredentials(env, accountId)
		});
	});
}
async function saveBackfilledMatrixDeviceId(credentials, env = process.env, accountId) {
	const credPath = resolveMatrixCredentialsPath(env, accountId);
	return await withCredentialWriteLock(credPath, async () => {
		const existing = loadMatrixCredentials(env, accountId);
		if (existing && (existing.homeserver !== credentials.homeserver || existing.userId !== credentials.userId || existing.accessToken !== credentials.accessToken)) return "skipped";
		await writeMatrixCredentialsUnlocked({
			credPath,
			credentials,
			existing
		});
		return "saved";
	});
}
async function touchMatrixCredentials(env = process.env, accountId) {
	const credPath = resolveMatrixCredentialsPath(env, accountId);
	await withCredentialWriteLock(credPath, async () => {
		const existing = loadMatrixCredentials(env, accountId);
		if (!existing) return;
		existing.lastUsedAt = (/* @__PURE__ */ new Date()).toISOString();
		await writeJsonFileAtomically(credPath, existing);
	});
}
//#endregion
export { clearMatrixCredentials, credentialsMatchConfig, loadMatrixCredentials, resolveMatrixCredentialsDir, resolveMatrixCredentialsPath, saveBackfilledMatrixDeviceId, saveMatrixCredentials, touchMatrixCredentials };
