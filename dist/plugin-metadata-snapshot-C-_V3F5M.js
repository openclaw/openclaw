import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { p as resolveIsNixMode } from "./paths-Cw7f9XhU.js";
import { n as appendRegularFileSync } from "./regular-file-DaVeNX32.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { o as resolveCompatibilityHostVersion } from "./version-CQfgAE7_.js";
import { t as isDiagnosticFlagEnabled } from "./diagnostic-flags-Bss2g5Mq.js";
import "./regular-file-CBe_wA_B.js";
import { a as resolveDefaultPluginNpmDir } from "./install-paths-B32RY-Gz.js";
import { g as resolveInstalledPluginIndexPolicyHash, y as hashJson } from "./installed-plugin-index-store-C1Oen9wR.js";
import { a as resolveInstalledPluginIndexStorePath, n as loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-Cy1cBr1u.js";
import { n as resolveInstalledManifestRegistryIndexFingerprint, t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-HgZGS-Bx.js";
import { S as createPluginRegistryIdNormalizer, m as loadPluginRegistrySnapshotWithMetadata, w as resolvePluginControlPlaneFingerprint } from "./plugin-registry-CgH_ZSlH.js";
import fs, { mkdirSync } from "node:fs";
import path, { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance as performance$1 } from "node:perf_hooks";
//#region src/infra/diagnostics-timeline.ts
const OPENCLAW_DIAGNOSTICS_TIMELINE_SCHEMA_VERSION = "openclaw.diagnostics.v1";
let warnedAboutTimelineWrite = false;
const createdTimelineDirs = /* @__PURE__ */ new Set();
const activeDiagnosticsTimelineSpan = new AsyncLocalStorage();
function resolveDiagnosticsTimelineOptions(options = {}) {
	return {
		env: options.env ?? process.env,
		...options.config ? { config: options.config } : {}
	};
}
function isDiagnosticsTimelineEnabled(options = {}) {
	const { config, env } = resolveDiagnosticsTimelineOptions(options);
	return (isDiagnosticFlagEnabled("timeline", config, env) || isDiagnosticFlagEnabled("diagnostics.timeline", config, env) || isTruthyEnvValue(env.OPENCLAW_DIAGNOSTICS)) && typeof env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH === "string" && env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH.trim().length > 0;
}
function normalizeNumber(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return Math.max(0, Math.round(value * 1e3) / 1e3);
}
function normalizeAttributes(attributes) {
	if (!attributes) return;
	const normalized = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (typeof value === "number") {
			if (Number.isFinite(value)) normalized[key] = normalizeNumber(value) ?? 0;
			continue;
		}
		if (typeof value === "string" || typeof value === "boolean" || value === null) normalized[key] = value;
	}
	return Object.keys(normalized).length > 0 ? normalized : void 0;
}
function serializeTimelineEvent(event, env) {
	const normalized = {
		schemaVersion: OPENCLAW_DIAGNOSTICS_TIMELINE_SCHEMA_VERSION,
		type: event.type,
		timestamp: event.timestamp ?? (/* @__PURE__ */ new Date()).toISOString(),
		name: event.name,
		...env.OPENCLAW_DIAGNOSTICS_RUN_ID ? { runId: env.OPENCLAW_DIAGNOSTICS_RUN_ID } : {},
		...env.OPENCLAW_DIAGNOSTICS_ENV ? { envName: env.OPENCLAW_DIAGNOSTICS_ENV } : {},
		pid: process.pid,
		...event.runId ? { runId: event.runId } : {},
		...event.envName ? { envName: event.envName } : {},
		...typeof event.pid === "number" ? { pid: event.pid } : {},
		...event.phase ? { phase: event.phase } : {},
		...event.spanId ? { spanId: event.spanId } : {},
		...event.parentSpanId ? { parentSpanId: event.parentSpanId } : {},
		...typeof event.durationMs === "number" ? { durationMs: normalizeNumber(event.durationMs) } : {},
		...event.errorName ? { errorName: event.errorName } : {},
		...event.errorMessage ? { errorMessage: event.errorMessage } : {},
		...typeof event.p50Ms === "number" ? { p50Ms: normalizeNumber(event.p50Ms) } : {},
		...typeof event.p95Ms === "number" ? { p95Ms: normalizeNumber(event.p95Ms) } : {},
		...typeof event.p99Ms === "number" ? { p99Ms: normalizeNumber(event.p99Ms) } : {},
		...typeof event.maxMs === "number" ? { maxMs: normalizeNumber(event.maxMs) } : {},
		...event.activeSpanName ? { activeSpanName: event.activeSpanName } : {},
		...event.provider ? { provider: event.provider } : {},
		...event.operation ? { operation: event.operation } : {},
		...typeof event.ok === "boolean" ? { ok: event.ok } : {},
		...event.command ? { command: event.command } : {},
		...event.exitCode !== void 0 ? { exitCode: event.exitCode } : {},
		...event.signal !== void 0 ? { signal: event.signal } : {},
		...normalizeAttributes(event.attributes) ? { attributes: normalizeAttributes(event.attributes) } : {}
	};
	return `${JSON.stringify(normalized)}\n`;
}
function emitDiagnosticsTimelineEvent(event, options = {}) {
	const { env } = resolveDiagnosticsTimelineOptions(options);
	if (!isDiagnosticsTimelineEnabled(options)) return;
	const path = env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH?.trim();
	if (!path) return;
	const line = serializeTimelineEvent(event, env);
	try {
		const dir = dirname(path);
		if (!createdTimelineDirs.has(dir)) {
			mkdirSync(dir, { recursive: true });
			createdTimelineDirs.add(dir);
		}
		appendRegularFileSync({
			filePath: path,
			content: line
		});
	} catch (error) {
		if (!warnedAboutTimelineWrite) {
			warnedAboutTimelineWrite = true;
			process.stderr.write(`[diagnostics] failed to write timeline event: ${String(error)}\n`);
		}
	}
}
function getActiveDiagnosticsTimelineSpan() {
	return activeDiagnosticsTimelineSpan.getStore();
}
async function measureDiagnosticsTimelineSpan(name, run, options = {}) {
	const env = options.env ?? process.env;
	if (!isDiagnosticsTimelineEnabled({
		config: options.config,
		env
	})) return await run();
	const activeSpan = getActiveDiagnosticsTimelineSpan();
	const spanId = randomUUID();
	const phase = options.phase ?? activeSpan?.phase;
	const parentSpanId = options.parentSpanId ?? activeSpan?.spanId;
	const startedAt = performance$1.now();
	emitDiagnosticsTimelineEvent({
		type: "span.start",
		name,
		phase,
		spanId,
		parentSpanId,
		attributes: options.attributes
	}, {
		config: options.config,
		env
	});
	try {
		const result = await activeDiagnosticsTimelineSpan.run({
			name,
			...phase ? { phase } : {},
			spanId,
			...parentSpanId ? { parentSpanId } : {},
			...options.attributes ? { attributes: options.attributes } : {}
		}, () => run());
		emitDiagnosticsTimelineEvent({
			type: "span.end",
			name,
			phase,
			spanId,
			parentSpanId,
			durationMs: performance$1.now() - startedAt,
			attributes: options.attributes
		}, {
			config: options.config,
			env
		});
		return result;
	} catch (error) {
		emitDiagnosticsTimelineEvent({
			type: "span.error",
			name,
			phase,
			spanId,
			parentSpanId,
			durationMs: performance$1.now() - startedAt,
			attributes: options.attributes,
			errorName: error instanceof Error ? error.name : typeof error,
			errorMessage: error instanceof Error ? error.message : String(error)
		}, {
			config: options.config,
			env
		});
		throw error;
	}
}
function measureDiagnosticsTimelineSpanSync(name, run, options = {}) {
	const env = options.env ?? process.env;
	if (!isDiagnosticsTimelineEnabled({
		config: options.config,
		env
	})) return run();
	const activeSpan = getActiveDiagnosticsTimelineSpan();
	const spanId = randomUUID();
	const phase = options.phase ?? activeSpan?.phase;
	const parentSpanId = options.parentSpanId ?? activeSpan?.spanId;
	const startedAt = performance$1.now();
	emitDiagnosticsTimelineEvent({
		type: "span.start",
		name,
		phase,
		spanId,
		parentSpanId,
		attributes: options.attributes
	}, {
		config: options.config,
		env
	});
	try {
		const result = activeDiagnosticsTimelineSpan.run({
			name,
			...phase ? { phase } : {},
			spanId,
			...parentSpanId ? { parentSpanId } : {},
			...options.attributes ? { attributes: options.attributes } : {}
		}, run);
		emitDiagnosticsTimelineEvent({
			type: "span.end",
			name,
			phase,
			spanId,
			parentSpanId,
			durationMs: performance$1.now() - startedAt,
			attributes: options.attributes
		}, {
			config: options.config,
			env
		});
		return result;
	} catch (error) {
		emitDiagnosticsTimelineEvent({
			type: "span.error",
			name,
			phase,
			spanId,
			parentSpanId,
			durationMs: performance$1.now() - startedAt,
			attributes: options.attributes,
			errorName: error instanceof Error ? error.name : typeof error,
			errorMessage: error instanceof Error ? error.message : String(error)
		}, {
			config: options.config,
			env
		});
		throw error;
	}
}
//#endregion
//#region src/plugins/plugin-metadata-snapshot.ts
let pluginMetadataSnapshotMemo;
function clearLoadPluginMetadataSnapshotMemo() {
	pluginMetadataSnapshotMemo = void 0;
}
const MEMO_RELEVANT_ENV_KEYS = [
	"APPDATA",
	"HOME",
	"OPENCLAW_BUNDLED_PLUGINS_DIR",
	"OPENCLAW_COMPATIBILITY_HOST_VERSION",
	"OPENCLAW_CONFIG_PATH",
	"OPENCLAW_DISABLE_BUNDLED_PLUGINS",
	"OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS",
	"OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY",
	"OPENCLAW_HOME",
	"OPENCLAW_NIX_MODE",
	"OPENCLAW_STATE_DIR",
	"USERPROFILE",
	"XDG_CONFIG_HOME"
];
function fileFingerprint(filePath) {
	try {
		const stat = fs.statSync(filePath, { bigint: true });
		return [
			filePath,
			stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other",
			stat.size.toString(),
			stat.mtimeNs.toString(),
			stat.ctimeNs.toString()
		];
	} catch {
		return [filePath, "missing"];
	}
}
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function readJsonObject(filePath) {
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return isRecord(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function normalizeString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function stableMemoValue(value) {
	if (Array.isArray(value)) return value.map(stableMemoValue);
	if (!isRecord(value)) return value;
	return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stableMemoValue(entry)]));
}
function isPathInsideOrEqual(childPath, parentPath) {
	const relative = path.relative(parentPath, childPath);
	return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative);
}
function tryRealpath(filePath) {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return null;
	}
}
function resolvePluginFilePath(pluginDir, filePath, options = {}) {
	if (!filePath) return {
		status: "missing-root",
		path: ""
	};
	const rootDir = path.resolve(pluginDir);
	const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(rootDir, filePath);
	if (!isPathInsideOrEqual(resolved, rootDir)) return {
		status: "outside-root",
		path: resolved
	};
	const rootRealPath = tryRealpath(rootDir);
	const targetRealPath = tryRealpath(resolved);
	if (rootRealPath && targetRealPath && !isPathInsideOrEqual(targetRealPath, rootRealPath) && !options.allowSymlinkOutsideRoot) return {
		status: "outside-root",
		path: resolved
	};
	return {
		status: "ok",
		path: resolved
	};
}
function persistedPluginFileFingerprint(rootDir, filePath, options = {}) {
	if (!filePath) return null;
	if (!rootDir) return [filePath, "missing-root"];
	const resolved = resolvePluginFilePath(rootDir, filePath, { allowSymlinkOutsideRoot: options.allowSymlinkOutsideRoot });
	if (resolved.status !== "ok") return [filePath, resolved.status];
	options.watchedFiles?.add(resolved.path);
	return fileFingerprint(resolved.path);
}
function watchedFileFingerprint(filePath, watchedFiles) {
	if (!filePath) return null;
	watchedFiles.add(filePath);
	return fileFingerprint(filePath);
}
function resolveInstallRecordPath(value, env) {
	const normalized = normalizeString(value);
	return normalized ? resolveUserPath(normalized, env) : void 0;
}
function installRecordPathFingerprints(env, records, watchedFiles) {
	if (!isRecord(records)) return [];
	return Object.entries(records).toSorted(([left], [right]) => left.localeCompare(right)).map(([pluginId, rawRecord]) => {
		if (!isRecord(rawRecord)) return [pluginId, rawRecord];
		const installPath = normalizeString(rawRecord.installPath);
		const sourcePath = normalizeString(rawRecord.sourcePath);
		const resolvedInstallPath = resolveInstallRecordPath(rawRecord.installPath, env);
		const resolvedSourcePath = resolveInstallRecordPath(rawRecord.sourcePath, env);
		return [
			pluginId,
			installPath,
			sourcePath,
			watchedFileFingerprint(resolvedInstallPath ? path.join(resolvedInstallPath, "package.json") : void 0, watchedFiles),
			watchedFileFingerprint(resolvedInstallPath ? path.join(resolvedInstallPath, "openclaw.plugin.json") : void 0, watchedFiles),
			watchedFileFingerprint(resolvedSourcePath, watchedFiles),
			watchedFileFingerprint(resolvedSourcePath ? path.join(resolvedSourcePath, "package.json") : void 0, watchedFiles),
			watchedFileFingerprint(resolvedSourcePath ? path.join(resolvedSourcePath, "openclaw.plugin.json") : void 0, watchedFiles)
		];
	});
}
function managedNpmDependencyMetadataFingerprints(npmRoot, watchedFiles) {
	const rootManifest = readJsonObject(path.join(npmRoot, "package.json"));
	const dependencies = isRecord(rootManifest?.dependencies) ? rootManifest.dependencies : {};
	const nodeModulesRoot = path.join(npmRoot, "node_modules");
	return Object.entries(dependencies).toSorted(([left], [right]) => left.localeCompare(right)).map(([packageName, rawSpec]) => {
		const dependencySpec = normalizeString(rawSpec);
		if (!dependencySpec) return [packageName, rawSpec];
		const packageDir = path.resolve(nodeModulesRoot, packageName);
		if (!isPathInsideOrEqual(packageDir, path.resolve(nodeModulesRoot))) return [
			packageName,
			dependencySpec,
			"outside-node-modules"
		];
		return [
			packageName,
			dependencySpec,
			watchedFileFingerprint(path.join(packageDir, "package.json"), watchedFiles),
			watchedFileFingerprint(path.join(packageDir, "openclaw.plugin.json"), watchedFiles)
		];
	});
}
function resolveRecordPackageJsonPath(record) {
	const packageJson = record.packageJson;
	if (!isRecord(packageJson)) return;
	return normalizeString(packageJson.path);
}
function pickMemoRelevantEnv(env) {
	return Object.fromEntries(MEMO_RELEVANT_ENV_KEYS.flatMap((key) => {
		const value = env[key];
		return value === void 0 ? [] : [[key, value]];
	}));
}
function cloneOwnerMaps(owners) {
	return {
		channels: new Map(owners.channels),
		channelConfigs: new Map(owners.channelConfigs),
		providers: new Map(owners.providers),
		modelCatalogProviders: new Map(owners.modelCatalogProviders),
		cliBackends: new Map(owners.cliBackends),
		setupProviders: new Map(owners.setupProviders),
		commandAliases: new Map(owners.commandAliases),
		contracts: new Map(owners.contracts)
	};
}
function cloneSnapshotValue(value) {
	return value && typeof value === "object" ? structuredClone(value) : value;
}
function clonePluginManifestRecord(plugin) {
	return cloneSnapshotValue(plugin);
}
function clonePluginMetadataSnapshot(snapshot) {
	const plugins = snapshot.plugins.map(clonePluginManifestRecord);
	const pluginsById = new Map(plugins.map((plugin) => [plugin.id, plugin]));
	const diagnostics = snapshot.diagnostics.map(cloneSnapshotValue);
	return {
		...snapshot,
		index: {
			...snapshot.index,
			installRecords: cloneSnapshotValue(snapshot.index.installRecords ?? {}),
			plugins: snapshot.index.plugins.map(cloneSnapshotValue),
			diagnostics: snapshot.index.diagnostics.map(cloneSnapshotValue)
		},
		registryDiagnostics: snapshot.registryDiagnostics.map(cloneSnapshotValue),
		manifestRegistry: {
			...snapshot.manifestRegistry,
			plugins,
			diagnostics
		},
		plugins,
		diagnostics,
		byPluginId: new Map([...snapshot.byPluginId.entries()].map(([pluginId, plugin]) => [pluginId, pluginsById.get(plugin.id) ?? clonePluginManifestRecord(plugin)])),
		owners: cloneOwnerMaps(snapshot.owners),
		metrics: { ...snapshot.metrics }
	};
}
function resolvePersistedRegistryFastMemoFingerprint(params) {
	const disabledByEnv = params.env.OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY?.trim().toLowerCase();
	if (params.preferPersisted === false || Boolean(disabledByEnv) && disabledByEnv !== "0" && disabledByEnv !== "false" && disabledByEnv !== "no") return { disabled: true };
	const indexPath = resolveInstalledPluginIndexStorePath({
		env: params.env,
		...params.stateDir ? { stateDir: params.stateDir } : {}
	});
	const npmRoot = params.stateDir ? path.join(params.stateDir, "npm") : resolveDefaultPluginNpmDir(params.env);
	return {
		index: fileFingerprint(indexPath),
		npmPackageJson: fileFingerprint(path.join(npmRoot, "package.json"))
	};
}
function resolvePersistedRegistryMemoContextHash(params) {
	return hashJson({
		env: pickMemoRelevantEnv(params.env),
		fastFingerprint: params.fastFingerprint,
		preferPersisted: params.preferPersisted ?? null,
		stateDir: params.stateDir ?? null
	});
}
function hashWatchedFiles(watchedFiles) {
	return hashJson(watchedFiles.map((filePath) => fileFingerprint(filePath)));
}
function resolvePersistedRegistryMemoState(params) {
	const fastFingerprint = resolvePersistedRegistryFastMemoFingerprint(params);
	const fastHash = hashJson(fastFingerprint);
	const contextHash = resolvePersistedRegistryMemoContextHash({
		...params,
		fastFingerprint
	});
	if (isRecord(fastFingerprint) && fastFingerprint.disabled === true) return {
		contextHash,
		fastHash,
		fingerprint: fastFingerprint,
		watchedFiles: [],
		watchedFilesHash: hashJson([])
	};
	const indexPath = resolveInstalledPluginIndexStorePath({
		env: params.env,
		...params.stateDir ? { stateDir: params.stateDir } : {}
	});
	const npmRoot = params.stateDir ? path.join(params.stateDir, "npm") : resolveDefaultPluginNpmDir(params.env);
	const index = params.index ?? readJsonObject(indexPath);
	const plugins = Array.isArray(index?.plugins) ? index.plugins : [];
	const diagnostics = Array.isArray(index?.diagnostics) ? index.diagnostics : [];
	const pluginRootById = /* @__PURE__ */ new Map();
	const watchedFiles = /* @__PURE__ */ new Set();
	for (const rawPlugin of plugins) {
		if (!isRecord(rawPlugin)) continue;
		const pluginId = normalizeString(rawPlugin.pluginId);
		const rootDir = normalizeString(rawPlugin.rootDir);
		if (pluginId && rootDir) pluginRootById.set(pluginId, rootDir);
	}
	const installRecords = params.index?.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({
		env: params.env,
		...params.stateDir ? { stateDir: params.stateDir } : {}
	});
	const watchedPlugins = plugins.map((rawPlugin) => {
		if (!isRecord(rawPlugin)) return rawPlugin;
		const rootDir = normalizeString(rawPlugin.rootDir);
		const manifestPath = normalizeString(rawPlugin.manifestPath);
		const packageJsonPath = resolveRecordPackageJsonPath(rawPlugin);
		const source = normalizeString(rawPlugin.source);
		const setupSource = normalizeString(rawPlugin.setupSource);
		return [
			normalizeString(rawPlugin.pluginId),
			rootDir,
			rootDir ? fileFingerprint(rootDir) : null,
			manifestPath,
			persistedPluginFileFingerprint(rootDir, manifestPath, { watchedFiles }),
			source,
			persistedPluginFileFingerprint(rootDir, source, { watchedFiles }),
			setupSource,
			persistedPluginFileFingerprint(rootDir, setupSource, { watchedFiles }),
			packageJsonPath,
			persistedPluginFileFingerprint(rootDir, packageJsonPath, {
				allowSymlinkOutsideRoot: true,
				watchedFiles
			})
		];
	});
	const watchedDiagnostics = diagnostics.map((rawDiagnostic) => {
		if (!isRecord(rawDiagnostic)) return rawDiagnostic;
		const pluginId = normalizeString(rawDiagnostic.pluginId);
		const source = normalizeString(rawDiagnostic.source);
		return [
			pluginId,
			source,
			persistedPluginFileFingerprint(pluginId ? pluginRootById.get(pluginId) : void 0, source, { watchedFiles })
		];
	});
	const installRecordFiles = installRecordPathFingerprints(params.env, installRecords, watchedFiles);
	const managedNpmDependencyFiles = managedNpmDependencyMetadataFingerprints(npmRoot, watchedFiles);
	const watchedFilesList = [...watchedFiles].toSorted();
	return {
		contextHash,
		fastHash,
		fingerprint: {
			...fastFingerprint,
			indexHash: hashJson(stableMemoValue(index) ?? null),
			installRecords: hashJson(stableMemoValue(installRecords)),
			installRecordFiles,
			managedNpmDependencyFiles,
			npmPackageJson: fileFingerprint(path.join(npmRoot, "package.json")),
			plugins: watchedPlugins,
			diagnostics: watchedDiagnostics
		},
		watchedFiles: watchedFilesList,
		watchedFilesHash: hashWatchedFiles(watchedFilesList)
	};
}
function resolvePersistedRegistryMemoStateForLookup(params, memo) {
	const fastFingerprint = resolvePersistedRegistryFastMemoFingerprint(params);
	const fastHash = hashJson(fastFingerprint);
	const contextHash = resolvePersistedRegistryMemoContextHash({
		...params,
		fastFingerprint
	});
	const registryState = memo?.registryState;
	if (registryState && registryState.contextHash === contextHash && registryState.fastHash === fastHash && hashWatchedFiles(registryState.watchedFiles) === registryState.watchedFilesHash) return registryState;
	return resolvePersistedRegistryMemoState(params);
}
function computePluginMetadataSnapshotMemoKey(params) {
	const { params: snapshotParams, registryState } = params;
	const env = snapshotParams.env ?? process.env;
	const indexFingerprint = snapshotParams.index ? resolveInstalledManifestRegistryIndexFingerprint(snapshotParams.index) : void 0;
	return hashJson({
		controlPlane: resolvePluginControlPlaneFingerprint({
			config: snapshotParams.config,
			env,
			workspaceDir: snapshotParams.workspaceDir,
			policyHash: resolveInstalledPluginIndexPolicyHash(snapshotParams.config),
			...indexFingerprint ? { inventoryFingerprint: indexFingerprint } : {}
		}),
		cwd: process.cwd(),
		env: pickMemoRelevantEnv(env),
		index: indexFingerprint ?? null,
		pathPolicy: {
			compatibilityHostVersion: resolveCompatibilityHostVersion(env),
			nixMode: resolveIsNixMode(env)
		},
		preferPersisted: snapshotParams.preferPersisted ?? null,
		registry: registryState.fingerprint,
		stateDir: snapshotParams.stateDir ? resolveUserPath(snapshotParams.stateDir, env) : null,
		workspaceDir: snapshotParams.workspaceDir ?? null
	});
}
function resolvePluginMetadataControlPlaneFingerprint(params) {
	return resolvePluginControlPlaneFingerprint(params);
}
function indexesMatch(left, right) {
	if (!left || !right) return true;
	return resolveInstalledManifestRegistryIndexFingerprint(left) === resolveInstalledManifestRegistryIndexFingerprint(right);
}
function normalizeInstalledPluginIndex(index) {
	return {
		version: index.version ?? 1,
		hostContractVersion: index.hostContractVersion ?? "",
		compatRegistryVersion: index.compatRegistryVersion ?? "",
		migrationVersion: index.migrationVersion ?? 1,
		policyHash: index.policyHash ?? "",
		generatedAtMs: index.generatedAtMs ?? 0,
		installRecords: index.installRecords ?? {},
		plugins: index.plugins ?? [],
		diagnostics: index.diagnostics ?? [],
		...index.warning ? { warning: index.warning } : {},
		...index.refreshReason ? { refreshReason: index.refreshReason } : {}
	};
}
function isPluginMetadataSnapshotCompatible(params) {
	const env = params.env ?? process.env;
	return params.snapshot.policyHash === resolveInstalledPluginIndexPolicyHash(params.config) && (!params.snapshot.configFingerprint || params.snapshot.configFingerprint === resolvePluginMetadataControlPlaneFingerprint({
		config: params.config,
		env,
		index: params.index ?? params.snapshot.index,
		policyHash: params.snapshot.policyHash,
		workspaceDir: params.workspaceDir
	})) && (params.snapshot.workspaceDir ?? "") === (params.workspaceDir ?? "") && indexesMatch(params.snapshot.index, params.index);
}
function appendOwner(owners, ownedId, pluginId) {
	const existing = owners.get(ownedId);
	if (existing) {
		existing.push(pluginId);
		return;
	}
	owners.set(ownedId, [pluginId]);
}
function freezeOwnerMap(owners) {
	return new Map([...owners.entries()].map(([ownedId, pluginIds]) => [ownedId, Object.freeze([...pluginIds])]));
}
function buildPluginMetadataOwnerMaps(plugins) {
	const channels = /* @__PURE__ */ new Map();
	const channelConfigs = /* @__PURE__ */ new Map();
	const providers = /* @__PURE__ */ new Map();
	const modelCatalogProviders = /* @__PURE__ */ new Map();
	const cliBackends = /* @__PURE__ */ new Map();
	const setupProviders = /* @__PURE__ */ new Map();
	const commandAliases = /* @__PURE__ */ new Map();
	const contracts = /* @__PURE__ */ new Map();
	for (const plugin of plugins) {
		for (const channelId of plugin.channels ?? []) appendOwner(channels, channelId, plugin.id);
		for (const channelId of Object.keys(plugin.channelConfigs ?? {})) appendOwner(channelConfigs, channelId, plugin.id);
		for (const providerId of plugin.providers ?? []) appendOwner(providers, providerId, plugin.id);
		for (const providerId of Object.keys(plugin.modelCatalog?.providers ?? {})) appendOwner(modelCatalogProviders, providerId, plugin.id);
		for (const providerId of Object.keys(plugin.modelCatalog?.aliases ?? {})) appendOwner(modelCatalogProviders, providerId, plugin.id);
		for (const cliBackendId of plugin.cliBackends ?? []) appendOwner(cliBackends, cliBackendId, plugin.id);
		for (const cliBackendId of plugin.setup?.cliBackends ?? []) appendOwner(cliBackends, cliBackendId, plugin.id);
		for (const setupProvider of plugin.setup?.providers ?? []) appendOwner(setupProviders, setupProvider.id, plugin.id);
		for (const commandAlias of plugin.commandAliases ?? []) appendOwner(commandAliases, commandAlias.name, plugin.id);
		for (const [contract, values] of Object.entries(plugin.contracts ?? {})) if (Array.isArray(values) && values.length > 0) appendOwner(contracts, contract, plugin.id);
	}
	return {
		channels: freezeOwnerMap(channels),
		channelConfigs: freezeOwnerMap(channelConfigs),
		providers: freezeOwnerMap(providers),
		modelCatalogProviders: freezeOwnerMap(modelCatalogProviders),
		cliBackends: freezeOwnerMap(cliBackends),
		setupProviders: freezeOwnerMap(setupProviders),
		commandAliases: freezeOwnerMap(commandAliases),
		contracts: freezeOwnerMap(contracts)
	};
}
function listPluginOriginsFromMetadataSnapshot(snapshot) {
	return new Map(snapshot.plugins.map((record) => [record.id, record.origin]));
}
function loadPluginMetadataSnapshot(params) {
	const activeTimelineSpan = getActiveDiagnosticsTimelineSpan();
	const memo = pluginMetadataSnapshotMemo;
	const env = params.env ?? process.env;
	const registryState = resolvePersistedRegistryMemoStateForLookup({
		env,
		...params.stateDir ? { stateDir: resolveUserPath(params.stateDir, env) } : {},
		...params.preferPersisted !== void 0 ? { preferPersisted: params.preferPersisted } : {}
	}, memo);
	const memoKey = computePluginMetadataSnapshotMemoKey({
		params,
		registryState
	});
	if (memo?.key === memoKey) return measureDiagnosticsTimelineSpanSync("plugins.metadata.scan", () => clonePluginMetadataSnapshot(memo.snapshot), {
		phase: activeTimelineSpan?.phase ?? "startup",
		config: params.config,
		env: params.env,
		attributes: {
			cacheHit: true,
			hasWorkspaceDir: params.workspaceDir !== void 0,
			hasInstalledIndex: params.index !== void 0
		}
	});
	const result = measureDiagnosticsTimelineSpanSync("plugins.metadata.scan", () => loadPluginMetadataSnapshotImpl(params), {
		phase: activeTimelineSpan?.phase ?? "startup",
		config: params.config,
		env: params.env,
		attributes: {
			hasWorkspaceDir: params.workspaceDir !== void 0,
			hasInstalledIndex: params.index !== void 0
		}
	});
	if (canMemoizePluginMetadataSnapshotResult(result)) {
		const cachedRegistryState = result.registrySource === "derived" ? resolvePersistedRegistryMemoState({
			env,
			index: result.snapshot.index,
			...params.stateDir ? { stateDir: resolveUserPath(params.stateDir, env) } : {},
			...params.preferPersisted !== void 0 ? { preferPersisted: params.preferPersisted } : {}
		}) : registryState;
		pluginMetadataSnapshotMemo = {
			key: computePluginMetadataSnapshotMemoKey({
				params,
				registryState: cachedRegistryState
			}),
			registryState: cachedRegistryState,
			snapshot: clonePluginMetadataSnapshot(result.snapshot)
		};
	}
	return result.snapshot;
}
function canMemoizePluginMetadataSnapshotResult(result) {
	return result.registrySource !== "derived" && result.snapshot.index.plugins.length > 0;
}
function loadPluginMetadataSnapshotImpl(params) {
	const totalStartedAt = performance.now();
	const registryStartedAt = performance.now();
	const registryResult = loadPluginRegistrySnapshotWithMetadata({
		config: params.config,
		workspaceDir: params.workspaceDir,
		...params.stateDir ? { stateDir: params.stateDir } : {},
		env: params.env,
		...params.preferPersisted !== void 0 ? { preferPersisted: params.preferPersisted } : {},
		...params.index ? { index: params.index } : {}
	}) ?? {
		source: "derived",
		snapshot: { plugins: [] },
		diagnostics: []
	};
	const registrySnapshotMs = performance.now() - registryStartedAt;
	const index = normalizeInstalledPluginIndex(registryResult.snapshot);
	const manifestStartedAt = performance.now();
	const manifestRegistry = index.plugins.length === 0 ? loadPluginManifestRegistry({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		diagnostics: [...index.diagnostics],
		installRecords: index.installRecords
	}) : loadPluginManifestRegistryForInstalledIndex({
		index,
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		includeDisabled: true
	});
	const manifestRegistryMs = performance.now() - manifestStartedAt;
	const normalizePluginId = createPluginRegistryIdNormalizer(index, { manifestRegistry });
	const byPluginId = new Map(manifestRegistry.plugins.map((plugin) => [plugin.id, plugin]));
	const ownerMapsStartedAt = performance.now();
	const owners = buildPluginMetadataOwnerMaps(manifestRegistry.plugins);
	const ownerMapsMs = performance.now() - ownerMapsStartedAt;
	const totalMs = performance.now() - totalStartedAt;
	return {
		registrySource: registryResult.source,
		snapshot: {
			policyHash: index.policyHash,
			registrySource: registryResult.source,
			configFingerprint: resolvePluginMetadataControlPlaneFingerprint({
				config: params.config,
				env: params.env,
				index,
				policyHash: index.policyHash,
				workspaceDir: params.workspaceDir
			}),
			...params.workspaceDir ? { workspaceDir: params.workspaceDir } : {},
			index,
			registryDiagnostics: registryResult.diagnostics,
			manifestRegistry,
			plugins: manifestRegistry.plugins,
			diagnostics: manifestRegistry.diagnostics,
			byPluginId,
			normalizePluginId,
			owners,
			metrics: {
				registrySnapshotMs,
				manifestRegistryMs,
				ownerMapsMs,
				totalMs,
				indexPluginCount: index.plugins.length,
				manifestPluginCount: manifestRegistry.plugins.length
			}
		}
	};
}
//#endregion
export { emitDiagnosticsTimelineEvent as a, measureDiagnosticsTimelineSpanSync as c, loadPluginMetadataSnapshot as i, isPluginMetadataSnapshotCompatible as n, isDiagnosticsTimelineEnabled as o, listPluginOriginsFromMetadataSnapshot as r, measureDiagnosticsTimelineSpan as s, clearLoadPluginMetadataSnapshotMemo as t };
