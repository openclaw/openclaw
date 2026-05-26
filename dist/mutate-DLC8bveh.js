import { s as resolveConfigPath } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { c as isRecord } from "./utils-sBTEdeml.js";
import { n as replaceFileAtomic } from "./replace-file-C7_Inj8B.js";
import "./scan-paths-BJFKmVji.js";
import { B as resolveManagedUnsetPathsForWrite, G as formatInvalidConfigDetails, T as validateConfigObjectWithPlugins, W as createInvalidConfigError, b as writeConfigFile, d as readConfigFileSnapshotForWrite, q as maintainConfigBackups, y as resolveConfigSnapshotHash, z as applyUnsetPathsForWrite } from "./io-DoswVvYe.js";
import { r as INCLUDE_KEY } from "./includes-DGwO3g_c.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-CW_6fgTB.js";
import { i as getRuntimeConfigSnapshot, m as resolveConfigWriteFollowUp, n as createRuntimeConfigWriteNotification, o as getRuntimeConfigSnapshotRefreshHandler, p as resolveConfigWriteAfterWrite, r as finalizeRuntimeSnapshotWrite, s as getRuntimeConfigSourceSnapshot, u as notifyRuntimeConfigWriteListeners } from "./runtime-snapshot-DgdkBEdP.js";
import { o as withFileLock } from "./file-lock-D5OTq3qW.js";
import "./file-lock-BSRN56ID.js";
import path from "node:path";
import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/config/mutate.ts
const CONFIG_MUTATION_LOCK_OPTIONS = {
	retries: {
		retries: 80,
		factor: 1.2,
		minTimeout: 25,
		maxTimeout: 250,
		randomize: true
	},
	stale: 3e4
};
const DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS = 5;
const activeConfigMutationLocks = new AsyncLocalStorage();
const configMutationQueueTails = /* @__PURE__ */ new Map();
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
async function withConfigMutationLock(params, fn) {
	if (params.io) return await fn();
	const configPath = path.resolve(params.lockPath ?? resolveConfigPath());
	const activeLocks = activeConfigMutationLocks.getStore();
	if (activeLocks?.has(configPath)) return await fn();
	assertConfigWriteAllowedInCurrentMode({ configPath });
	await fs.mkdir(path.dirname(configPath), {
		recursive: true,
		mode: 448
	});
	const previousTail = configMutationQueueTails.get(configPath) ?? Promise.resolve();
	let releaseQueueSlot;
	const currentRun = new Promise((resolve) => {
		releaseQueueSlot = resolve;
	});
	const currentTail = previousTail.catch(() => void 0).then(() => currentRun);
	configMutationQueueTails.set(configPath, currentTail);
	await previousTail.catch(() => void 0);
	try {
		const nextActiveLocks = new Set(activeLocks ?? []);
		nextActiveLocks.add(configPath);
		return await activeConfigMutationLocks.run(nextActiveLocks, async () => await withFileLock(configPath, CONFIG_MUTATION_LOCK_OPTIONS, fn));
	} finally {
		releaseQueueSlot();
		if (configMutationQueueTails.get(configPath) === currentTail) configMutationQueueTails.delete(configPath);
	}
}
function markActiveConfigMutationPath(configPath) {
	activeConfigMutationLocks.getStore()?.add(path.resolve(configPath));
}
async function readConfigSnapshotForMutation(params) {
	if (params.io) return await params.io.readConfigFileSnapshotForWrite();
	return await readConfigFileSnapshotForWrite({ skipPluginValidation: params.writeOptions?.skipPluginValidation });
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
	if (changedKeys.length !== 1 || changedKeys[0] === "<root>") return null;
	const key = changedKeys[0];
	const includePath = getSingleTopLevelIncludeTarget({
		snapshot: params.snapshot,
		key
	});
	if (!includePath || !isRecord(nextConfig) || !(key in nextConfig)) return null;
	const nextConfigRecord = nextConfig;
	const validated = validateConfigObjectWithPlugins(nextConfig, params.writeOptions?.skipPluginValidation ? { pluginValidation: "skip" } : void 0);
	if (!validated.ok) throw createInvalidConfigError(params.snapshot.path, formatInvalidConfigDetails(validated.issues));
	const runtimeConfigSnapshot = getRuntimeConfigSnapshot();
	const runtimeConfigSourceSnapshot = getRuntimeConfigSourceSnapshot();
	const hadRuntimeSnapshot = Boolean(runtimeConfigSnapshot);
	const hadBothSnapshots = Boolean(runtimeConfigSnapshot && runtimeConfigSourceSnapshot);
	await writeJsonFileAtomic(includePath, nextConfigRecord[key]);
	if (params.writeOptions?.skipRuntimeSnapshotRefresh && !hadRuntimeSnapshot && !getRuntimeConfigSnapshotRefreshHandler()) return {
		persistedHash: null,
		persistedConfig: nextConfig
	};
	const refreshedSnapshot = (await (params.io?.readConfigFileSnapshotForWrite ?? readConfigFileSnapshotForWrite)(params.writeOptions?.skipPluginValidation ? { skipPluginValidation: true } : void 0)).snapshot;
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
		refreshOptions: params.writeOptions?.runtimeRefresh,
		hadRuntimeSnapshot,
		hadBothSnapshots,
		loadFreshConfig: () => refreshedSnapshot.runtimeConfig,
		notifyCommittedWrite,
		formatRefreshError: (error) => formatErrorMessage(error),
		createRefreshError: (detail, cause) => new Error(`Config was written to ${params.snapshot.path}, but runtime snapshot refresh failed: ${detail}`, { cause })
	});
	return {
		persistedHash,
		persistedConfig: refreshedSnapshot.sourceConfig
	};
}
function resolveConfigWriteResult(result, fallbackConfig) {
	if (result) return {
		persistedHash: result.persistedHash,
		persistedConfig: result.persistedConfig
	};
	return {
		persistedHash: null,
		persistedConfig: fallbackConfig
	};
}
async function replaceConfigFile(params) {
	return await withConfigMutationLock({
		io: params.io,
		lockPath: params.snapshot?.path
	}, async () => await replaceConfigFileUnlocked(params));
}
async function replaceConfigFileUnlocked(params) {
	const { snapshot, writeOptions } = params.snapshot && params.writeOptions ? {
		snapshot: params.snapshot,
		writeOptions: params.writeOptions
	} : await readConfigSnapshotForMutation({
		io: params.io,
		writeOptions: params.writeOptions
	});
	assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
	markActiveConfigMutationPath(snapshot.path);
	const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
	const afterWrite = resolveConfigWriteAfterWrite(params.afterWrite ?? params.writeOptions?.afterWrite);
	let writeResult = await tryWriteSingleTopLevelIncludeMutation({
		snapshot,
		nextConfig: params.nextConfig,
		afterWrite,
		writeOptions: params.writeOptions ?? writeOptions,
		io: params.io
	});
	if (!writeResult) writeResult = resolveConfigWriteResult(await (params.io?.writeConfigFile ?? writeConfigFile)(params.nextConfig, {
		baseSnapshot: snapshot,
		...writeOptions,
		...params.writeOptions,
		afterWrite
	}), params.nextConfig);
	return {
		path: snapshot.path,
		previousHash,
		snapshot,
		nextConfig: writeResult.persistedConfig,
		persistedHash: writeResult.persistedHash,
		afterWrite,
		followUp: resolveConfigWriteFollowUp(afterWrite)
	};
}
async function commitPreparedConfigMutation(params) {
	const result = await replaceConfigFileUnlocked({
		nextConfig: params.nextConfig,
		snapshot: params.snapshot,
		baseHash: params.baseHash,
		writeOptions: {
			...params.writeOptions,
			afterWrite: params.afterWrite
		},
		io: params.io
	});
	return {
		config: result.nextConfig,
		persistedHash: result.persistedHash,
		afterWrite: result.afterWrite
	};
}
async function transformConfigFileAttempt(params, attempt) {
	const { snapshot, writeOptions } = await readConfigSnapshotForMutation({
		io: params.io,
		writeOptions: params.writeOptions
	});
	assertConfigWriteAllowedInCurrentMode({ configPath: snapshot.path });
	markActiveConfigMutationPath(snapshot.path);
	const previousHash = assertBaseHashMatches(snapshot, params.baseHash);
	const baseConfig = params.base === "runtime" ? snapshot.runtimeConfig : snapshot.sourceConfig;
	const afterWrite = resolveConfigWriteAfterWrite(params.afterWrite ?? params.writeOptions?.afterWrite);
	const mergedWriteOptions = {
		...writeOptions,
		...params.writeOptions
	};
	const transformed = await params.transform(baseConfig, {
		snapshot,
		previousHash,
		attempt
	});
	const committed = await (params.commit ?? commitPreparedConfigMutation)({
		nextConfig: transformed.nextConfig,
		snapshot,
		...previousHash !== null ? { baseHash: previousHash } : {},
		writeOptions: mergedWriteOptions,
		afterWrite,
		io: params.io
	});
	const committedAfterWrite = committed.afterWrite ?? afterWrite;
	return {
		path: snapshot.path,
		previousHash,
		snapshot,
		nextConfig: committed.config,
		persistedHash: committed.persistedHash,
		result: transformed.result,
		attempts: attempt + 1,
		afterWrite: committedAfterWrite,
		followUp: resolveConfigWriteFollowUp(committedAfterWrite)
	};
}
async function transformConfigFile(params) {
	return await withConfigMutationLock({ io: params.io }, async () => await transformConfigFileAttempt(params, 0));
}
async function transformConfigFileWithRetry(params) {
	const maxAttempts = params.maxAttempts ?? DEFAULT_CONFIG_MUTATION_RETRY_ATTEMPTS;
	if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Config mutation maxAttempts must be a positive integer.");
	return await withConfigMutationLock({ io: params.io }, async () => {
		for (let attempt = 0; attempt < maxAttempts; attempt += 1) try {
			return await transformConfigFileAttempt(params, attempt);
		} catch (err) {
			if (err instanceof ConfigMutationConflictError && attempt < maxAttempts - 1) continue;
			throw err;
		}
		throw new Error("Config mutation retry loop exhausted unexpectedly.");
	});
}
async function mutateConfigFile(params) {
	return await transformConfigFile({
		base: params.base,
		baseHash: params.baseHash,
		afterWrite: params.afterWrite,
		writeOptions: params.writeOptions,
		io: params.io,
		transform: async (currentConfig, context) => {
			const draft = structuredClone(currentConfig);
			return {
				nextConfig: draft,
				result: await params.mutate(draft, context)
			};
		}
	});
}
async function mutateConfigFileWithRetry(params) {
	return await transformConfigFileWithRetry({
		base: params.base,
		baseHash: params.baseHash,
		maxAttempts: params.maxAttempts,
		afterWrite: params.afterWrite,
		writeOptions: params.writeOptions,
		io: params.io,
		transform: async (currentConfig, context) => {
			const draft = structuredClone(currentConfig);
			return {
				nextConfig: draft,
				result: await params.mutate(draft, context)
			};
		}
	});
}
//#endregion
export { transformConfigFile as a, replaceConfigFile as i, mutateConfigFile as n, transformConfigFileWithRetry as o, mutateConfigFileWithRetry as r, ConfigMutationConflictError as t };
