import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { d as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./ssrf-policy-DsfOWjYU.js";
import "./ssrf-runtime-BGM8nkUl.js";
import "./string-coerce-runtime-BMQDVfjj.js";
import { t as resolveValidatedMatrixHomeserverUrl } from "./url-validation-BoA7gSAT.js";
import { a as resolveMatrixStoragePaths, n as maybeMigrateLegacyStorage, o as writeStorageMeta } from "./storage-DmwWoMKk.js";
import "./config-mU5IYErB.js";
import fs from "node:fs";
//#region extensions/matrix/src/matrix/client/create-client.ts
let matrixCreateClientRuntimeDepsPromise;
async function loadMatrixCreateClientRuntimeDeps() {
	matrixCreateClientRuntimeDepsPromise ??= Promise.all([import("./sdk-Dzvi2GJa.js"), import("./logging-Brd3JsDJ.js")]).then(([sdkModule, loggingModule]) => ({
		MatrixClient: sdkModule.MatrixClient,
		ensureMatrixSdkLoggingConfigured: loggingModule.ensureMatrixSdkLoggingConfigured
	}));
	return await matrixCreateClientRuntimeDepsPromise;
}
async function createMatrixClient(params) {
	const { MatrixClient, ensureMatrixSdkLoggingConfigured } = await loadMatrixCreateClientRuntimeDeps();
	ensureMatrixSdkLoggingConfigured();
	const homeserver = await resolveValidatedMatrixHomeserverUrl(params.homeserver, { dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork });
	const matrixClientUserId = normalizeOptionalString(params.userId);
	const userId = matrixClientUserId ?? "unknown";
	const storagePaths = params.persistStorage !== false ? resolveMatrixStoragePaths({
		homeserver,
		userId,
		accessToken: params.accessToken,
		accountId: params.accountId,
		deviceId: params.deviceId,
		env: process.env
	}) : null;
	if (storagePaths) {
		await maybeMigrateLegacyStorage({
			storagePaths,
			env: process.env
		});
		fs.mkdirSync(storagePaths.rootDir, { recursive: true });
		writeStorageMeta({
			storagePaths,
			homeserver,
			userId,
			accountId: params.accountId,
			deviceId: params.deviceId
		});
	}
	const cryptoDatabasePrefix = storagePaths ? `openclaw-matrix-${storagePaths.accountKey}-${storagePaths.tokenHash}` : void 0;
	return new MatrixClient(homeserver, params.accessToken, {
		userId: matrixClientUserId,
		password: params.password,
		deviceId: params.deviceId,
		encryption: params.encryption,
		localTimeoutMs: params.localTimeoutMs,
		initialSyncLimit: params.initialSyncLimit,
		storagePath: storagePaths?.storagePath,
		recoveryKeyPath: storagePaths?.recoveryKeyPath,
		idbSnapshotPath: storagePaths?.idbSnapshotPath,
		cryptoDatabasePrefix,
		autoBootstrapCrypto: params.autoBootstrapCrypto,
		ssrfPolicy: params.ssrfPolicy ?? ssrfPolicyFromDangerouslyAllowPrivateNetwork(params.allowPrivateNetwork),
		dispatcherPolicy: params.dispatcherPolicy
	});
}
//#endregion
export { createMatrixClient as t };
