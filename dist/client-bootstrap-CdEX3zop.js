import { t as requireRuntimeConfig } from "./plugin-config-runtime-DWa7yCpn.js";
import { t as getActiveMatrixClient } from "./active-client-oYl5IAAm.js";
import { t as isBunRuntime } from "./runtime-BefyhPWv.js";
//#region extensions/matrix/src/matrix/client-bootstrap.ts
let matrixSharedClientRuntimeDepsPromise;
async function loadMatrixSharedClientRuntimeDeps() {
	matrixSharedClientRuntimeDepsPromise ??= Promise.all([import("./client-tP1GxHBe.js"), import("./shared-DmxchHfI.js")]).then(([clientModule, sharedModule]) => ({
		acquireSharedMatrixClient: clientModule.acquireSharedMatrixClient,
		resolveMatrixAuthContext: clientModule.resolveMatrixAuthContext,
		releaseSharedClientInstance: sharedModule.releaseSharedClientInstance
	}));
	return await matrixSharedClientRuntimeDepsPromise;
}
async function ensureResolvedClientReadiness(params) {
	if (params.readiness === "started") {
		await params.client.start();
		return;
	}
	if (params.readiness === "prepared" || !params.readiness && params.preparedByDefault) await params.client.prepareForOneOff();
}
function ensureMatrixNodeRuntime() {
	if (isBunRuntime()) throw new Error("Matrix support requires Node (bun runtime not supported)");
}
async function resolveRuntimeMatrixClient(opts) {
	ensureMatrixNodeRuntime();
	if (opts.client) {
		await opts.onResolved?.(opts.client, { preparedByDefault: false });
		return {
			client: opts.client,
			stopOnDone: false
		};
	}
	if (!opts.cfg) throw new Error("Matrix runtime client requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
	const cfg = requireRuntimeConfig(opts.cfg, "Matrix runtime client");
	const { acquireSharedMatrixClient, releaseSharedClientInstance, resolveMatrixAuthContext } = await loadMatrixSharedClientRuntimeDeps();
	const authContext = resolveMatrixAuthContext({
		cfg,
		accountId: opts.accountId
	});
	const active = getActiveMatrixClient(authContext.accountId);
	if (active) {
		await opts.onResolved?.(active, { preparedByDefault: false });
		return {
			client: active,
			stopOnDone: false
		};
	}
	const client = await acquireSharedMatrixClient({
		cfg,
		timeoutMs: opts.timeoutMs,
		accountId: authContext.accountId,
		startClient: false
	});
	try {
		await opts.onResolved?.(client, { preparedByDefault: true });
	} catch (err) {
		await releaseSharedClientInstance(client, "stop");
		throw err;
	}
	return {
		client,
		stopOnDone: true,
		cleanup: async (mode) => {
			await releaseSharedClientInstance(client, mode);
		}
	};
}
async function resolveRuntimeMatrixClientWithReadiness(opts) {
	return await resolveRuntimeMatrixClient({
		client: opts.client,
		cfg: opts.cfg,
		timeoutMs: opts.timeoutMs,
		accountId: opts.accountId,
		onResolved: async (client, context) => {
			await ensureResolvedClientReadiness({
				client,
				readiness: opts.readiness,
				preparedByDefault: context.preparedByDefault
			});
		}
	});
}
async function stopResolvedRuntimeMatrixClient(resolved, mode = "stop") {
	if (!resolved.stopOnDone) return;
	if (resolved.cleanup) {
		await resolved.cleanup(mode);
		return;
	}
	if (mode === "persist") {
		await resolved.client.stopAndPersist();
		return;
	}
	if (mode === "discard") {
		resolved.client.stopWithoutPersist();
		return;
	}
	resolved.client.stop();
}
async function withResolvedRuntimeMatrixClient(opts, run, stopMode = "stop") {
	const resolved = await resolveRuntimeMatrixClientWithReadiness(opts);
	try {
		return await run(resolved.client);
	} finally {
		await stopResolvedRuntimeMatrixClient(resolved, stopMode);
	}
}
//#endregion
export { stopResolvedRuntimeMatrixClient as n, withResolvedRuntimeMatrixClient as r, resolveRuntimeMatrixClientWithReadiness as t };
