import { createHash } from "node:crypto";
//#region src/config/runtime-snapshot.ts
function resolveConfigWriteAfterWrite(afterWrite) {
	return afterWrite ?? { mode: "auto" };
}
function resolveConfigWriteFollowUp(afterWrite) {
	const resolved = resolveConfigWriteAfterWrite(afterWrite);
	if (resolved.mode === "restart") return {
		mode: "restart",
		reason: resolved.reason,
		requiresRestart: true
	};
	if (resolved.mode === "none") return {
		mode: "none",
		reason: resolved.reason,
		requiresRestart: false
	};
	return {
		mode: "auto",
		requiresRestart: false
	};
}
let runtimeConfigSnapshot = null;
let runtimeConfigSourceSnapshot = null;
let runtimeConfigSnapshotMetadata = null;
let runtimeConfigSnapshotRevision = 0;
let runtimeConfigSnapshotRefreshHandler = null;
const runtimeConfigWriteListeners = /* @__PURE__ */ new Set();
function stableConfigStringify(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((entry) => stableConfigStringify(entry)).join(",")}]`;
	const record = value;
	return `{${Object.keys(record).toSorted().map((key) => `${JSON.stringify(key)}:${stableConfigStringify(record[key])}`).join(",")}}`;
}
function configSnapshotsMatch(left, right) {
	if (left === right) return true;
	try {
		return stableConfigStringify(left) === stableConfigStringify(right);
	} catch {
		return false;
	}
}
function hashRuntimeConfigValue(value) {
	return createHash("sha256").update(stableConfigStringify(value)).digest("base64url");
}
function createRuntimeConfigSnapshotMetadata(config, sourceConfig) {
	runtimeConfigSnapshotRevision += 1;
	return {
		revision: runtimeConfigSnapshotRevision,
		fingerprint: hashRuntimeConfigValue(config),
		sourceFingerprint: sourceConfig ? hashRuntimeConfigValue(sourceConfig) : null,
		updatedAtMs: Date.now()
	};
}
function setRuntimeConfigSnapshot(config, sourceConfig) {
	runtimeConfigSnapshot = config;
	runtimeConfigSourceSnapshot = sourceConfig ?? null;
	runtimeConfigSnapshotMetadata = createRuntimeConfigSnapshotMetadata(config, sourceConfig);
}
function resetConfigRuntimeState() {
	runtimeConfigSnapshot = null;
	runtimeConfigSourceSnapshot = null;
	runtimeConfigSnapshotMetadata = null;
	runtimeConfigSnapshotRevision = 0;
}
function clearRuntimeConfigSnapshot() {
	resetConfigRuntimeState();
}
function getRuntimeConfigSnapshot() {
	return runtimeConfigSnapshot;
}
function getRuntimeConfigSourceSnapshot() {
	return runtimeConfigSourceSnapshot;
}
function getRuntimeConfigSnapshotMetadata() {
	return runtimeConfigSnapshotMetadata;
}
function resolveRuntimeConfigCacheKey(config) {
	const metadata = runtimeConfigSnapshotMetadata;
	if (metadata && config === runtimeConfigSnapshot) return `runtime:${metadata.revision}:${metadata.fingerprint}`;
	return `config:${hashRuntimeConfigValue(config)}`;
}
function createRuntimeConfigWriteNotification(params) {
	const metadata = params.runtimeConfig === runtimeConfigSnapshot && runtimeConfigSnapshotMetadata ? runtimeConfigSnapshotMetadata : {
		revision: runtimeConfigSnapshotRevision,
		fingerprint: hashRuntimeConfigValue(params.runtimeConfig),
		sourceFingerprint: hashRuntimeConfigValue(params.sourceConfig),
		updatedAtMs: Date.now()
	};
	return {
		configPath: params.configPath,
		sourceConfig: params.sourceConfig,
		runtimeConfig: params.runtimeConfig,
		persistedHash: params.persistedHash,
		revision: metadata.revision,
		fingerprint: metadata.fingerprint,
		sourceFingerprint: metadata.sourceFingerprint,
		writtenAtMs: params.writtenAtMs ?? Date.now(),
		afterWrite: params.afterWrite
	};
}
function selectApplicableRuntimeConfig(params) {
	const runtimeConfig = params.runtimeConfig ?? null;
	if (!runtimeConfig) return params.inputConfig;
	const inputConfig = params.inputConfig;
	if (!inputConfig) return runtimeConfig;
	if (inputConfig === runtimeConfig) return inputConfig;
	const runtimeSourceConfig = params.runtimeSourceConfig ?? null;
	if (!runtimeSourceConfig) return runtimeConfig;
	if (configSnapshotsMatch(inputConfig, runtimeSourceConfig)) return runtimeConfig;
	return inputConfig;
}
function setRuntimeConfigSnapshotRefreshHandler(refreshHandler) {
	runtimeConfigSnapshotRefreshHandler = refreshHandler;
}
function getRuntimeConfigSnapshotRefreshHandler() {
	return runtimeConfigSnapshotRefreshHandler;
}
function registerRuntimeConfigWriteListener(listener) {
	runtimeConfigWriteListeners.add(listener);
	return () => {
		runtimeConfigWriteListeners.delete(listener);
	};
}
function notifyRuntimeConfigWriteListeners(event) {
	for (const listener of runtimeConfigWriteListeners) try {
		listener(event);
	} catch {}
}
function loadPinnedRuntimeConfig(loadFresh) {
	if (runtimeConfigSnapshot) return runtimeConfigSnapshot;
	const config = loadFresh();
	setRuntimeConfigSnapshot(config);
	return getRuntimeConfigSnapshot() ?? config;
}
async function finalizeRuntimeSnapshotWrite(params) {
	const refreshHandler = getRuntimeConfigSnapshotRefreshHandler();
	if (refreshHandler) try {
		if (await refreshHandler.refresh({ sourceConfig: params.nextSourceConfig })) {
			params.notifyCommittedWrite();
			return;
		}
	} catch (error) {
		try {
			refreshHandler.clearOnRefreshFailure?.();
		} catch {}
		throw params.createRefreshError(params.formatRefreshError(error), error);
	}
	if (params.hadBothSnapshots) {
		setRuntimeConfigSnapshot(params.loadFreshConfig(), params.nextSourceConfig);
		params.notifyCommittedWrite();
		return;
	}
	if (params.hadRuntimeSnapshot) {
		setRuntimeConfigSnapshot(params.loadFreshConfig());
		params.notifyCommittedWrite();
		return;
	}
	setRuntimeConfigSnapshot(params.loadFreshConfig());
	params.notifyCommittedWrite();
}
//#endregion
export { setRuntimeConfigSnapshot as _, getRuntimeConfigSnapshotMetadata as a, hashRuntimeConfigValue as c, registerRuntimeConfigWriteListener as d, resetConfigRuntimeState as f, selectApplicableRuntimeConfig as g, resolveRuntimeConfigCacheKey as h, getRuntimeConfigSnapshot as i, loadPinnedRuntimeConfig as l, resolveConfigWriteFollowUp as m, createRuntimeConfigWriteNotification as n, getRuntimeConfigSnapshotRefreshHandler as o, resolveConfigWriteAfterWrite as p, finalizeRuntimeSnapshotWrite as r, getRuntimeConfigSourceSnapshot as s, clearRuntimeConfigSnapshot as t, notifyRuntimeConfigWriteListeners as u, setRuntimeConfigSnapshotRefreshHandler as v };
