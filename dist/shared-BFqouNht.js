import { r as normalizeOptionalAccountId } from "./account-id-B32J-iNN.js";
import { n as LogService } from "./logger-CjN9_ytq.js";
import { t as awaitMatrixStartupWithAbort } from "./startup-abort-B-YL8CNT.js";
import { n as resolveMatrixAuth, r as resolveMatrixAuthContext } from "./config-zGJE8Xzj.js";
//#region extensions/matrix/src/matrix/client/shared.ts
let matrixCreateClientDepsPromise;
async function loadMatrixCreateClientDeps() {
	matrixCreateClientDepsPromise ??= import("./create-client-DwGisNXG.js").then((runtime) => ({ createMatrixClient: runtime.createMatrixClient }));
	return await matrixCreateClientDepsPromise;
}
const sharedClientStates = /* @__PURE__ */ new Map();
const sharedClientPromises = /* @__PURE__ */ new Map();
function serializeDispatcherPolicyKey(auth) {
	return JSON.stringify(auth.dispatcherPolicy ?? null);
}
function buildSharedClientKey(auth) {
	return [
		auth.homeserver,
		auth.userId,
		auth.accessToken,
		auth.encryption ? "e2ee" : "plain",
		auth.allowPrivateNetwork ? "private-net" : "strict-net",
		serializeDispatcherPolicyKey(auth),
		auth.accountId
	].join("|");
}
async function createSharedMatrixClient(params) {
	const { createMatrixClient } = await loadMatrixCreateClientDeps();
	return {
		client: await createMatrixClient({
			homeserver: params.auth.homeserver,
			userId: params.auth.userId,
			accessToken: params.auth.accessToken,
			password: params.auth.password,
			deviceId: params.auth.deviceId,
			encryption: params.auth.encryption,
			localTimeoutMs: params.timeoutMs,
			initialSyncLimit: params.auth.initialSyncLimit,
			accountId: params.auth.accountId,
			allowPrivateNetwork: params.auth.allowPrivateNetwork,
			ssrfPolicy: params.auth.ssrfPolicy,
			dispatcherPolicy: params.auth.dispatcherPolicy
		}),
		key: buildSharedClientKey(params.auth),
		started: false,
		cryptoReady: false,
		startPromise: null,
		leases: 0
	};
}
function findSharedClientStateByInstance(client) {
	for (const state of sharedClientStates.values()) if (state.client === client) return state;
	return null;
}
function deleteSharedClientState(state) {
	sharedClientStates.delete(state.key);
	sharedClientPromises.delete(state.key);
}
async function ensureSharedClientStarted(params) {
	const waitForStart = async (startPromise) => {
		await awaitMatrixStartupWithAbort(startPromise, params.abortSignal);
	};
	if (params.state.started) return;
	if (params.state.startPromise) {
		await waitForStart(params.state.startPromise);
		return;
	}
	const guardedStart = (async () => {
		const client = params.state.client;
		if (params.encryption && !params.state.cryptoReady) try {
			const joinedRooms = await client.getJoinedRooms();
			if (client.crypto) {
				await client.crypto.prepare(joinedRooms);
				params.state.cryptoReady = true;
			}
		} catch (err) {
			LogService.warn("MatrixClientLite", "Failed to prepare crypto:", err);
		}
		await client.start({ abortSignal: params.abortSignal });
		params.state.started = true;
	})().finally(() => {
		if (params.state.startPromise === guardedStart) params.state.startPromise = null;
	});
	params.state.startPromise = guardedStart;
	await waitForStart(guardedStart);
}
async function resolveSharedMatrixClientState(params = {}) {
	const requestedAccountId = normalizeOptionalAccountId(params.accountId);
	if (params.auth && requestedAccountId && requestedAccountId !== params.auth.accountId) throw new Error(`Matrix shared client account mismatch: requested ${requestedAccountId}, auth resolved ${params.auth.accountId}`);
	const authContext = (() => {
		if (params.auth) return null;
		if (!params.cfg) throw new Error("Matrix shared client requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
		return resolveMatrixAuthContext({
			cfg: params.cfg,
			env: params.env,
			accountId: params.accountId
		});
	})();
	const auth = params.auth ?? await resolveMatrixAuth({
		cfg: authContext?.cfg ?? params.cfg,
		env: authContext?.env ?? params.env,
		accountId: authContext?.accountId
	});
	const key = buildSharedClientKey(auth);
	const shouldStart = params.startClient !== false;
	const existingState = sharedClientStates.get(key);
	if (existingState) {
		if (shouldStart) await ensureSharedClientStarted({
			state: existingState,
			encryption: auth.encryption,
			abortSignal: params.abortSignal
		});
		return existingState;
	}
	const existingPromise = sharedClientPromises.get(key);
	if (existingPromise) {
		const pending = await existingPromise;
		if (shouldStart) await ensureSharedClientStarted({
			state: pending,
			encryption: auth.encryption,
			abortSignal: params.abortSignal
		});
		return pending;
	}
	const creationPromise = createSharedMatrixClient({
		auth,
		timeoutMs: params.timeoutMs
	});
	sharedClientPromises.set(key, creationPromise);
	try {
		const created = await creationPromise;
		sharedClientStates.set(key, created);
		if (shouldStart) await ensureSharedClientStarted({
			state: created,
			encryption: auth.encryption,
			abortSignal: params.abortSignal
		});
		return created;
	} finally {
		sharedClientPromises.delete(key);
	}
}
async function resolveSharedMatrixClient(params = {}) {
	return (await resolveSharedMatrixClientState(params)).client;
}
async function acquireSharedMatrixClient(params = {}) {
	const state = await resolveSharedMatrixClientState(params);
	state.leases += 1;
	return state.client;
}
function stopSharedClient() {
	for (const state of sharedClientStates.values()) state.client.stop();
	sharedClientStates.clear();
	sharedClientPromises.clear();
}
function stopSharedClientForAccount(auth) {
	const key = buildSharedClientKey(auth);
	const state = sharedClientStates.get(key);
	if (!state) return;
	state.client.stop();
	deleteSharedClientState(state);
}
function removeSharedClientInstance(client) {
	const state = findSharedClientStateByInstance(client);
	if (!state) return false;
	deleteSharedClientState(state);
	return true;
}
function stopSharedClientInstance(client) {
	if (!removeSharedClientInstance(client)) return;
	client.stop();
}
async function releaseSharedClientInstance(client, mode = "stop") {
	const state = findSharedClientStateByInstance(client);
	if (!state) return false;
	state.leases = Math.max(0, state.leases - 1);
	if (state.leases > 0) return false;
	deleteSharedClientState(state);
	if (mode === "persist") await client.stopAndPersist();
	else if (mode === "discard") client.stopWithoutPersist();
	else client.stop();
	return true;
}
//#endregion
export { stopSharedClient as a, resolveSharedMatrixClient as i, releaseSharedClientInstance as n, stopSharedClientForAccount as o, removeSharedClientInstance as r, stopSharedClientInstance as s, acquireSharedMatrixClient as t };
