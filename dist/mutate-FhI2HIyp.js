import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { i as isPathInside } from "./path-B5B-_oAT.js";
import { c as isRecord } from "./utils-CKsuXgDI.js";
import { n as replaceFileAtomic } from "./replace-file-VPhXrtU-.js";
import "./scan-paths-CQGIktzD.js";
import { B as resolveManagedUnsetPathsForWrite, K as maintainConfigBackups, T as validateConfigObjectWithPlugins, U as createInvalidConfigError, W as formatInvalidConfigDetails, b as writeConfigFile, d as readConfigFileSnapshotForWrite, y as resolveConfigSnapshotHash, z as applyUnsetPathsForWrite } from "./io-5xE1dPMK.js";
import { r as INCLUDE_KEY } from "./includes-CuflrSI8.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-BqXH8Kti.js";
import { i as getRuntimeConfigSnapshot, m as resolveConfigWriteFollowUp, n as createRuntimeConfigWriteNotification, o as getRuntimeConfigSnapshotRefreshHandler, p as resolveConfigWriteAfterWrite, r as finalizeRuntimeSnapshotWrite, s as getRuntimeConfigSourceSnapshot, u as notifyRuntimeConfigWriteListeners } from "./runtime-snapshot-tLK3Mx7y.js";
import path from "node:path";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
//#region src/config/mutate.ts
var ConfigMutationConflictError = class extends Error {
	constructor(message, params) {
		super(message);
		this.name = "ConfigMutationConflictError";
		this.currentHash = params.currentHash;
	}
};
function assertBaseHashMatches(snapshot, expectedHash) {
	const currentHash = resolveConfigSnapshotHash(snapshot) ?? null;
	if (expectedHash !== void 0 && expectedHash !== currentHash) throw new ConfigMutationConflictError("config changed since last load", { currentHash });
	return currentHash;
}
function getChangedTopLevelKeys(base, next) {
	if (!isRecord(base) || !isRecord(next)) return isDeepStrictEqual(base, next) ? [] : ["<root>"];
	return [...new Set([...Object.keys(base), ...Object.keys(next)])].filter((key) => !isDeepStrictEqual(base[key], next[key]));
}
function getSingleTopLevelIncludeTarget(params) {
	if (!isRecord(params.snapshot.parsed)) return null;
	const authoredSection = params.snapshot.parsed[params.key];
	if (!isRecord(authoredSection)) return null;
	const keys = Object.keys(authoredSection);
	const includeValue = authoredSection[INCLUDE_KEY];
	if (keys.length !== 1 || typeof includeValue !== "string") return null;
	const rootDir = path.dirname(params.snapshot.path);
	const resolved = path.normalize(path.isAbsolute(includeValue) ? includeValue : path.resolve(rootDir, includeValue));
	if (!isPathInside(rootDir, resolved)) return null;
	return resolved;
}
async function writeJsonFileAtomic(filePath, value) {
	await replaceFileAtomic({
		filePath,
		content: `${JSON.stringify(value, null, 2)}\n`,
		dirMode: 448,
		mode: 384,
		tempPrefix: path.basename(filePath),
		beforeRename: async () => {
			await fs.access(filePath).then(async () => await maintainConfigBackups(filePath, fs), () => void 0);
		}
	});
}
async function tryWriteSingleTopLevelIncludeMutation(params) {
	const nextConfig = applyUnsetPathsForWrite(params.nextConfig, resolveManagedUnsetPathsForWrite(params.writeOptions?.unsetPaths));
	const changedKeys = getChangedTopLevelKeys(params.snapshot.sourceConfig, nextConfig);
	if (changedKeys.length !== 1 || changedKeys[0] === "<root>") return false;
	const key = changedKeys[0];
	const includePath = getSingleTopLevelIncludeTarget({
		snapshot: params.snapshot,
		key
	});
	if (!includePath || !isRecord(nextConfig) || !(key in nextConfig)) return false;
	const nextConfigRecord = nextConfig;
	if (params.writeOptions?.skipPluginValidation) return false;
	const validated = validateConfigObjectWithPlugins(nextConfig);
	if (!validated.ok) throw createInvalidConfigError(params.snapshot.path, formatInvalidConfigDetails(validated.issues));
	const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
	const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
	const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
	const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
	await writeJsonFileAtomic(includePath, nextConfigRecord[key]);
	if (params.writeOptions?.skipRuntimeSnapshotRefresh && !hadRuntimeSnapshot && !getRuntimeConfigSnapshotRefreshHandler()) return true;
	const refreshedSnapshot = (await (params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite)()).snapshot;
	const persistedHash = resolveConfigSnapshotHash(refreshedSnapshot);
	if (!refreshedSnapshot.valid) throw createInvalidConfigError(params.snapshot.path, formatInvalidConfigDetails(refreshedSnapshot.issues));
	if (!persistedHash) throw new Error(`Config was written to ${params.snapshot.path}, but no persisted hash was available.`);
	const notifyCommittedWrite = () => {
		const currentRuntimeConfig = getRuntimeConfigSnapshot();
		if (!currentRuntimeConfig) return;
		notifyRuntimeConfigWriteListeners(createRuntimeConfigWriteNotification({
			configPath: params.snapshot.path,
			sourceConfig: refreshedSnapshot.sourceConfig,
			runtimeConfig: currentRuntimeConfig,
			persistedHash,
			afterWrite: params.afterWrite ?? params.writeOptions?.afterWrite
		}));
	};
	await finalizeRuntimeSnapshotWrite({
		nextSourceConfig: refreshedSnapshot.sourceConfig,
		hadRuntimeSnapshot,
		hadBothSnapshots,
		loadFreshConfig: () => refreshedSnapshot.runtimeConfig,
		notifyCommittedWrite,
		formatRefreshError: (error) => formatErrorMessage(error),
		createRefreshError: (detail, cause) => new Error(`Config was written to ${params.snapshot.path}, but runtime snapshot refresh failed: ${detail}`, { cause })
	});
	return true;
}
async function replaceConfigFile(params) {
	const { snapshot, writeOptions } = params.snapshot && params.writeOptions ? {
		snapshot: params.snapshot,
		writeOptions: params.writeOptions
	} : await (params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite)();
	assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
	const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
	const afterWrite = resolveConfigWriteAfterWrite(params.afterWrite ?? params.writeOptions?.afterWrite);
	if (!await tryWriteSingleTopLevelIncludeMutation({
		snapshot,
		nextConfig: params.nextConfig,
		afterWrite,
		writeOptions: params.writeOptions ?? writeOptions,
		io: params.io
	})) await (params.io?.writeConfigFile ?? writeConfigFile)(params.nextConfig, {
		baseSnapshot: snapshot,
		...writeOptions,
		...params.writeOptions,
		afterWrite
	});
	return {
		path: snapshot.path,
		previousHash,
		snapshot,
		nextConfig: params.nextConfig,
		afterWrite,
		followUp: resolveConfigWriteFollowUp(afterWrite)
	};
}
async function mutateConfigFile(params) {
	const { snapshot, writeOptions } = await (params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite)();
	assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
	const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
	const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
	const draft = structuredClone(baseConfig);
	const result = await params.mutate(draft, {
		snapshot,
		previousHash
	});
	const afterWrite = resolveConfigWriteAfterWrite(params.afterWrite ?? params.writeOptions?.afterWrite);
	if (!await tryWriteSingleTopLevelIncludeMutation({
		snapshot,
		nextConfig: draft,
		afterWrite,
		writeOptions: {
			...writeOptions,
			...params.writeOptions
		},
		io: params.io
	})) await (params.io?.writeConfigFile ?? writeConfigFile)(draft, {
		...writeOptions,
		...params.writeOptions,
		afterWrite
	});
	return {
		path: snapshot.path,
		previousHash,
		snapshot,
		nextConfig: draft,
		result,
		afterWrite,
		followUp: resolveConfigWriteFollowUp(afterWrite)
	};
}
//#endregion
export { mutateConfigFile as n, replaceConfigFile as r, ConfigMutationConflictError as t };
