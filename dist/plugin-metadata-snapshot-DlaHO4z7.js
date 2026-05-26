import { t as isTruthyEnvValue } from "./env-DL0trrAI.js";
import { i as resolvePluginCacheInputs } from "./discovery-BEbYTYvv.js";
import { n as appendRegularFileSync } from "./regular-file-6GdZVPgG.js";
import { t as isDiagnosticFlagEnabled } from "./diagnostic-flags-BAYJHjtr.js";
import "./regular-file-BGI9Nxdy.js";
import { _ as resolveInstalledPluginIndexPolicyHash, y as hashJson } from "./installed-plugin-index-store-DetkjvO9.js";
import { t as loadPluginManifestRegistry } from "./manifest-registry-Dgt5v-vG.js";
import { n as resolveInstalledManifestRegistryIndexFingerprint, t as loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed-Cr9K7amI.js";
import { g as createPluginRegistryIdNormalizer, m as loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry-Cdr1zbpf.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
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
//#region src/plugins/plugin-control-plane-context.ts
function resolveConfiguredPluginLoadPaths(config) {
	const paths = config?.plugins?.load?.paths;
	return Array.isArray(paths) ? paths : void 0;
}
function resolvePluginDiscoveryContext(params = {}) {
	return resolvePluginCacheInputs({
		env: params.env ?? process.env,
		workspaceDir: params.workspaceDir,
		loadPaths: [...params.loadPaths ?? resolveConfiguredPluginLoadPaths(params.config) ?? []]
	});
}
function fingerprintPluginDiscoveryContext(context) {
	return hashJson(context);
}
function resolvePluginControlPlaneContext(params = {}) {
	const inventoryFingerprint = params.inventoryFingerprint ?? (params.index ? resolveInstalledManifestRegistryIndexFingerprint(params.index) : void 0);
	return {
		discovery: resolvePluginDiscoveryContext(params),
		policyFingerprint: params.policyHash ?? resolveInstalledPluginIndexPolicyHash(params.config),
		...inventoryFingerprint ? { inventoryFingerprint } : {},
		...params.activationFingerprint ? { activationFingerprint: params.activationFingerprint } : {}
	};
}
function resolvePluginControlPlaneFingerprint(params = {}) {
	return fingerprintPluginControlPlaneContext(resolvePluginControlPlaneContext(params));
}
function fingerprintPluginControlPlaneContext(context) {
	return hashJson(context);
}
//#endregion
//#region src/plugins/plugin-metadata-snapshot.ts
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
	return measureDiagnosticsTimelineSpanSync("plugins.metadata.scan", () => loadPluginMetadataSnapshotImpl(params), {
		phase: getActiveDiagnosticsTimelineSpan()?.phase ?? "startup",
		config: params.config,
		env: params.env,
		attributes: {
			hasWorkspaceDir: params.workspaceDir !== void 0,
			hasInstalledIndex: params.index !== void 0
		}
	});
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
		policyHash: index.policyHash,
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
	};
}
//#endregion
export { resolvePluginControlPlaneFingerprint as a, isDiagnosticsTimelineEnabled as c, fingerprintPluginDiscoveryContext as i, measureDiagnosticsTimelineSpan as l, listPluginOriginsFromMetadataSnapshot as n, resolvePluginDiscoveryContext as o, loadPluginMetadataSnapshot as r, emitDiagnosticsTimelineEvent as s, isPluginMetadataSnapshotCompatible as t, measureDiagnosticsTimelineSpanSync as u };
