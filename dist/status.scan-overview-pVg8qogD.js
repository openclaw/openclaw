import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { o as resolveConfigPath } from "./paths-Cnwfh6dH.js";
import { t as createLazyImportLoader } from "./lazy-promise-SFT4i6yI.js";
import { n as defaultSlotIdForKey } from "./slots-DLJ2h3Qv.js";
import { i as runExec } from "./exec-DusmGtXL.js";
import { u as isLoopbackIpAddress } from "./ip-Db8k2XjS.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-CgOISqZp.js";
import { t as buildGatewayConnectionDetailsWithResolvers } from "./connection-details-DA7jZ41J.js";
import { t as resolveGatewayProbeTarget } from "./probe-target-DQ4RDGo0.js";
import { r as normalizeControlUiBasePath } from "./control-ui-shared-CUokriKj.js";
import { t as createEmptyTaskRegistrySummary } from "./task-registry.summary-C_bUa0ta.js";
import { n as createEmptyTaskAuditSummary } from "./task-registry.audit.shared-DBmoktSk.js";
import { t as resolveOsSummary } from "./os-summary-Nn96w4KK.js";
import { l as hasConfiguredChannelsForReadOnlyScope } from "./channel-plugin-ids-C3NqlKLT.js";
import { t as resolveGatewayAuthTokenSourceConflict } from "./auth-token-source-conflict-D9oKkuBo.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-MS1CXjJj.js";
import { i as isProbeReachable } from "./helpers-BKskrPuM.js";
import { existsSync } from "node:fs";
//#region src/commands/status.scan.shared.ts
const gatewayProbeModuleLoader = createLazyImportLoader(() => import("./status.gateway-probe-BzDZTEXN.js"));
const probeGatewayModuleLoader = createLazyImportLoader(() => import("./probe-DT85QZBC.js"));
const gatewayCallModuleLoader$1 = createLazyImportLoader(() => import("./call-CuKQnsm3.js"));
function loadGatewayProbeModule() {
	return gatewayProbeModuleLoader.load();
}
function loadProbeGatewayModule() {
	return probeGatewayModuleLoader.load();
}
function loadGatewayCallModule$1() {
	return gatewayCallModuleLoader$1.load();
}
function isLoopbackGatewayUrl(rawUrl) {
	try {
		const hostname = new URL(rawUrl).hostname.toLowerCase();
		const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
		return unbracketed === "localhost" || isLoopbackIpAddress(unbracketed);
	} catch {
		return false;
	}
}
function shouldTryLocalStatusRpcFallback(params) {
	if (params.gatewayMode !== "local" || !params.gatewayProbe || params.gatewayProbe.ok || !isLoopbackGatewayUrl(params.gatewayUrl)) return false;
	return (params.gatewayProbe.error?.toLowerCase() ?? "").includes("timeout") || params.gatewayProbe.auth?.capability === "unknown";
}
async function applyLocalStatusRpcFallback(params) {
	if (!shouldTryLocalStatusRpcFallback(params)) return params.gatewayProbe;
	const boundedFallbackTimeoutMs = Math.min(2e3, Math.max(1e3, params.timeoutMs));
	const status = await loadGatewayCallModule$1().then(({ callGateway }) => callGateway({
		config: params.cfg,
		method: "status",
		token: params.gatewayProbeAuth.token,
		password: params.gatewayProbeAuth.password,
		timeoutMs: params.timeoutMsExplicit ? boundedFallbackTimeoutMs : Math.max(params.cfg.gateway?.handshakeTimeoutMs ?? 0, boundedFallbackTimeoutMs),
		mode: GATEWAY_CLIENT_MODES.BACKEND,
		clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT
	})).catch(() => null);
	if (!status) return params.gatewayProbe;
	const auth = params.gatewayProbe.auth;
	return {
		...params.gatewayProbe,
		ok: true,
		status,
		auth: auth.capability === "unknown" ? {
			...auth,
			capability: "read_only"
		} : auth
	};
}
function hasExplicitMemorySearchConfig(cfg, agentId) {
	if (cfg.agents?.defaults && Object.prototype.hasOwnProperty.call(cfg.agents.defaults, "memorySearch")) return true;
	return (Array.isArray(cfg.agents?.list) ? cfg.agents.list : []).some((agent) => agent?.id === agentId && Object.prototype.hasOwnProperty.call(agent, "memorySearch"));
}
function resolveMemoryPluginStatus(cfg) {
	if (!(cfg.plugins?.enabled !== false)) return {
		enabled: false,
		slot: null,
		reason: "plugins disabled"
	};
	const raw = normalizeOptionalString(cfg.plugins?.slots?.memory) ?? "";
	if (normalizeOptionalLowercaseString(raw) === "none") return {
		enabled: false,
		slot: null,
		reason: "plugins.slots.memory=\"none\""
	};
	return {
		enabled: true,
		slot: raw || defaultSlotIdForKey("memory")
	};
}
async function resolveGatewayProbeSnapshot(params) {
	const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({ config: params.cfg });
	const { gatewayMode, remoteUrlMissing } = resolveGatewayProbeTarget(params.cfg);
	const shouldResolveAuth = params.opts.skipProbe !== true && (!remoteUrlMissing || params.opts.resolveAuthWhenRemoteUrlMissing === true);
	const shouldProbe = params.opts.skipProbe !== true && (!remoteUrlMissing || params.opts.probeWhenRemoteUrlMissing === true);
	const gatewayProbeAuthResolution = shouldResolveAuth ? await loadGatewayProbeModule().then(({ resolveGatewayProbeAuthResolution }) => resolveGatewayProbeAuthResolution(params.cfg)) : {
		auth: {},
		warning: void 0
	};
	let gatewayProbeAuthWarning = gatewayProbeAuthResolution.warning;
	const defaultProbeTimeoutMs = Math.max(params.opts.all ? 5e3 : 2500, params.cfg.gateway?.handshakeTimeoutMs ?? 0);
	const timeoutMsExplicit = params.opts.timeoutMs !== void 0;
	const probeTimeoutMs = params.opts.timeoutMs ?? defaultProbeTimeoutMs;
	const initialGatewayProbe = shouldProbe ? await loadProbeGatewayModule().then(({ probeGateway }) => probeGateway({
		url: gatewayConnection.url,
		auth: gatewayProbeAuthResolution.auth,
		preauthHandshakeTimeoutMs: params.cfg.gateway?.handshakeTimeoutMs,
		timeoutMs: probeTimeoutMs,
		detailLevel: params.opts.detailLevel ?? "presence"
	})).catch(() => null) : null;
	const gatewayProbe = await applyLocalStatusRpcFallback({
		cfg: params.cfg,
		gatewayMode,
		gatewayUrl: gatewayConnection.url,
		gatewayProbe: initialGatewayProbe,
		gatewayProbeAuth: gatewayProbeAuthResolution.auth,
		timeoutMs: probeTimeoutMs,
		timeoutMsExplicit
	});
	if ((params.opts.mergeAuthWarningIntoProbeError ?? true) && gatewayProbeAuthWarning && gatewayProbe?.ok === false) {
		gatewayProbe.error = gatewayProbe.error ? `${gatewayProbe.error}; ${gatewayProbeAuthWarning}` : gatewayProbeAuthWarning;
		gatewayProbeAuthWarning = void 0;
	}
	const gatewayReachable = gatewayProbe ? isProbeReachable(gatewayProbe) : false;
	const gatewaySelf = gatewayProbe?.presence ? pickGatewaySelfPresence(gatewayProbe.presence) : null;
	return {
		gatewayConnection,
		remoteUrlMissing,
		gatewayMode,
		gatewayProbeAuth: gatewayProbeAuthResolution.auth,
		gatewayProbeAuthWarning,
		gatewayProbe,
		gatewayReachable,
		gatewaySelf,
		...remoteUrlMissing ? { gatewayCallOverrides: {
			url: gatewayConnection.url,
			token: gatewayProbeAuthResolution.auth.token,
			password: gatewayProbeAuthResolution.auth.password
		} } : {}
	};
}
function buildTailscaleHttpsUrl(params) {
	return params.tailscaleMode !== "off" && params.tailscaleDns ? `https://${params.tailscaleDns}${normalizeControlUiBasePath(params.controlUiBasePath)}` : null;
}
async function resolveSharedMemoryStatusSnapshot(params) {
	const { cfg, agentStatus, memoryPlugin } = params;
	if (!memoryPlugin.enabled || !memoryPlugin.slot) return null;
	const agentId = agentStatus.defaultId ?? "main";
	if (memoryPlugin.slot !== defaultSlotIdForKey("memory")) return await resolveMemoryManagerStatusSnapshot(params, agentId);
	const defaultStorePath = params.requireDefaultStore?.(agentId);
	if (defaultStorePath && !hasExplicitMemorySearchConfig(cfg, agentId) && !existsSync(defaultStorePath)) return null;
	const resolvedMemory = params.resolveMemoryConfig(cfg, agentId);
	if (!resolvedMemory) return null;
	if (!(hasExplicitMemorySearchConfig(cfg, agentId) || existsSync(resolvedMemory.store.path))) return null;
	return await resolveMemoryManagerStatusSnapshot(params, agentId);
}
async function resolveMemoryManagerStatusSnapshot(params, agentId) {
	const { manager } = await params.getMemorySearchManager({
		cfg: params.cfg,
		agentId,
		purpose: "status"
	});
	if (!manager) return null;
	try {
		try {
			if (manager.status().backend === "builtin" && manager.probeVectorStoreAvailability) await manager.probeVectorStoreAvailability();
			else await manager.probeVectorAvailability();
		} catch {}
		return {
			agentId,
			...manager.status()
		};
	} finally {
		await manager.close?.().catch(() => {});
	}
}
//#endregion
//#region src/commands/status.scan.bootstrap-shared.ts
function buildColdStartUpdateResult() {
	return {
		root: null,
		installKind: "unknown",
		packageManager: "unknown"
	};
}
function buildColdStartAgentLocalStatuses() {
	return {
		defaultId: "main",
		agents: [],
		totalSessions: 0,
		bootstrapPendingCount: 0
	};
}
function buildColdStartStatusSummary() {
	return {
		runtimeVersion: null,
		heartbeat: {
			defaultAgentId: "main",
			agents: []
		},
		channelSummary: [],
		queuedSystemEvents: [],
		tasks: createEmptyTaskRegistrySummary(),
		taskAudit: createEmptyTaskAuditSummary(),
		sessions: {
			paths: [],
			count: 0,
			defaults: {
				model: null,
				contextTokens: null
			},
			recent: [],
			byAgent: []
		}
	};
}
function shouldSkipStatusScanNetworkChecks(params) {
	return params.coldStart && !params.hasConfiguredChannels && params.all !== true;
}
async function createStatusScanCoreBootstrap(params) {
	const tailscaleMode = params.cfg.gateway?.tailscale?.mode ?? "off";
	const skipColdStartNetworkChecks = shouldSkipStatusScanNetworkChecks({
		coldStart: params.coldStart,
		hasConfiguredChannels: params.hasConfiguredChannels,
		all: params.opts.all
	});
	const updateTimeoutMs = params.opts.all ? 6500 : 2500;
	const tailscaleDnsPromise = tailscaleMode === "off" ? Promise.resolve(null) : params.getTailnetHostname((cmd, args) => runExec(cmd, args, {
		timeoutMs: 1200,
		maxBuffer: 2e5
	})).catch(() => null);
	return {
		tailscaleMode,
		tailscaleDnsPromise,
		updatePromise: skipColdStartNetworkChecks ? Promise.resolve(buildColdStartUpdateResult()) : params.getUpdateCheckResult({
			timeoutMs: updateTimeoutMs,
			fetchGit: true,
			includeRegistry: true,
			updateConfigChannel: params.cfg.update?.channel ?? null
		}),
		agentStatusPromise: skipColdStartNetworkChecks ? Promise.resolve(buildColdStartAgentLocalStatuses()) : params.getAgentLocalStatuses(params.cfg),
		gatewayProbePromise: resolveGatewayProbeSnapshot({
			cfg: params.cfg,
			opts: {
				...params.opts,
				...skipColdStartNetworkChecks ? { skipProbe: true } : {}
			}
		}),
		skipColdStartNetworkChecks,
		resolveTailscaleHttpsUrl: async () => buildTailscaleHttpsUrl({
			tailscaleMode,
			tailscaleDns: await tailscaleDnsPromise,
			controlUiBasePath: params.cfg.gateway?.controlUi?.basePath
		})
	};
}
//#endregion
//#region src/commands/status.scan.config-shared.ts
function shouldSkipStatusScanMissingConfigFastPath(env = process.env) {
	return env.VITEST === "true" || env.VITEST_POOL_ID !== void 0 || env.NODE_ENV === "test";
}
function resolveStatusScanColdStart(params) {
	const env = params?.env ?? process.env;
	return !(params?.allowMissingConfigFastPath === true && shouldSkipStatusScanMissingConfigFastPath(env)) && !existsSync(resolveConfigPath(env));
}
async function loadStatusScanCommandConfig(params) {
	const env = params.env ?? process.env;
	const coldStart = resolveStatusScanColdStart({
		env,
		allowMissingConfigFastPath: params.allowMissingConfigFastPath
	});
	const sourceConfig = coldStart && params.allowMissingConfigFastPath === true ? {} : await params.readBestEffortConfig();
	const { resolvedConfig, diagnostics } = coldStart && params.allowMissingConfigFastPath === true ? {
		resolvedConfig: sourceConfig,
		diagnostics: []
	} : await params.resolveConfig(sourceConfig);
	const tokenConflict = resolveGatewayAuthTokenSourceConflict({
		cfg: sourceConfig,
		env
	});
	return {
		coldStart,
		sourceConfig,
		resolvedConfig,
		secretDiagnostics: tokenConflict ? [...diagnostics, tokenConflict.diagnostic] : diagnostics
	};
}
//#endregion
//#region src/commands/status.scan-overview.ts
const statusScanDepsRuntimeModuleLoader = createLazyImportLoader(() => import("./status.scan.deps.runtime.js"));
const statusAgentLocalModuleLoader = createLazyImportLoader(() => import("./status.agent-local-C0BPxd_V.js"));
const statusUpdateModuleLoader = createLazyImportLoader(() => import("./status.update-Cs5QlNmp.js"));
const statusScanRuntimeModuleLoader = createLazyImportLoader(() => import("./status.scan.runtime.js"));
const gatewayCallModuleLoader = createLazyImportLoader(() => import("./call-CuKQnsm3.js"));
const statusSummaryModuleLoader = createLazyImportLoader(() => import("./status.summary-BqLhBPPO.js"));
const configModuleLoader = createLazyImportLoader(() => import("./config/config.js"));
const commandConfigResolutionModuleLoader = createLazyImportLoader(() => import("./command-config-resolution-BcWWdL1i.js"));
const commandSecretTargetsModuleLoader = createLazyImportLoader(() => import("./command-secret-targets-Bz79BA0c.js"));
function loadStatusScanDepsRuntimeModule() {
	return statusScanDepsRuntimeModuleLoader.load();
}
function loadStatusAgentLocalModule() {
	return statusAgentLocalModuleLoader.load();
}
function loadStatusUpdateModule() {
	return statusUpdateModuleLoader.load();
}
function loadStatusScanRuntimeModule() {
	return statusScanRuntimeModuleLoader.load();
}
function loadGatewayCallModule() {
	return gatewayCallModuleLoader.load();
}
function loadStatusSummaryModule() {
	return statusSummaryModuleLoader.load();
}
function loadConfigModule() {
	return configModuleLoader.load();
}
function loadCommandConfigResolutionModule() {
	return commandConfigResolutionModuleLoader.load();
}
function loadCommandSecretTargetsModule() {
	return commandSecretTargetsModuleLoader.load();
}
async function resolveStatusChannelsStatus(params) {
	if (!params.gatewayReachable) return null;
	const { callGateway } = await loadGatewayCallModule();
	return await callGateway({
		config: params.cfg,
		method: "channels.status",
		params: {
			probe: false,
			timeoutMs: Math.min(8e3, params.opts.timeoutMs ?? 1e4)
		},
		timeoutMs: Math.min(params.opts.all ? 5e3 : 2500, params.opts.timeoutMs ?? 1e4),
		...params.useGatewayCallOverrides === true ? params.gatewayCallOverrides ?? {} : {}
	}).catch(() => null);
}
async function collectStatusScanOverview(params) {
	if (params.labels?.loadingConfig) params.progress?.setLabel(params.labels.loadingConfig);
	const { coldStart, sourceConfig, resolvedConfig: cfg, secretDiagnostics } = await loadStatusScanCommandConfig({
		commandName: params.commandName,
		allowMissingConfigFastPath: params.allowMissingConfigFastPath,
		readBestEffortConfig: async () => (await loadConfigModule()).readBestEffortConfig(),
		resolveConfig: async (loadedConfig) => await (await loadCommandConfigResolutionModule()).resolveCommandConfigWithSecrets({
			config: loadedConfig,
			commandName: params.commandName,
			targetIds: (await loadCommandSecretTargetsModule()).getStatusCommandSecretTargetIds(loadedConfig),
			mode: "read_only_status",
			...params.runtime ? { runtime: params.runtime } : {}
		})
	});
	params.progress?.tick();
	const hasConfiguredChannels = params.resolveHasConfiguredChannels ? params.resolveHasConfiguredChannels(cfg, sourceConfig) : hasConfiguredChannelsForReadOnlyScope({
		config: cfg,
		activationSourceConfig: sourceConfig
	});
	const osSummary = resolveOsSummary();
	const bootstrap = await createStatusScanCoreBootstrap({
		coldStart,
		cfg,
		hasConfiguredChannels,
		opts: params.opts,
		getTailnetHostname: async (runner) => await loadStatusScanDepsRuntimeModule().then(({ getTailnetHostname }) => getTailnetHostname(runner)),
		getUpdateCheckResult: async (updateParams) => await loadStatusUpdateModule().then(({ getUpdateCheckResult }) => getUpdateCheckResult(updateParams)),
		getAgentLocalStatuses: async (bootstrapCfg) => await loadStatusAgentLocalModule().then(({ getAgentLocalStatuses }) => getAgentLocalStatuses(bootstrapCfg))
	});
	if (params.labels?.checkingTailscale) params.progress?.setLabel(params.labels.checkingTailscale);
	const tailscaleDns = await bootstrap.tailscaleDnsPromise;
	params.progress?.tick();
	if (params.labels?.checkingForUpdates) params.progress?.setLabel(params.labels.checkingForUpdates);
	const update = await bootstrap.updatePromise;
	params.progress?.tick();
	if (params.labels?.resolvingAgents) params.progress?.setLabel(params.labels.resolvingAgents);
	const agentStatus = await bootstrap.agentStatusPromise;
	params.progress?.tick();
	if (params.labels?.probingGateway) params.progress?.setLabel(params.labels.probingGateway);
	const gatewaySnapshot = await bootstrap.gatewayProbePromise;
	params.progress?.tick();
	const tailscaleHttpsUrl = await bootstrap.resolveTailscaleHttpsUrl();
	const includeChannelsData = params.includeChannelsData !== false;
	const includeLiveChannelStatus = params.includeLiveChannelStatus !== false;
	const { channelsStatus, channelIssues, channels } = includeChannelsData ? await (async () => {
		if (params.labels?.queryingChannelStatus) params.progress?.setLabel(params.labels.queryingChannelStatus);
		const channelsStatus = includeLiveChannelStatus ? await resolveStatusChannelsStatus({
			cfg,
			gatewayReachable: gatewaySnapshot.gatewayReachable,
			opts: params.opts,
			gatewayCallOverrides: gatewaySnapshot.gatewayCallOverrides,
			useGatewayCallOverrides: params.useGatewayCallOverridesForChannelsStatus
		}) : null;
		params.progress?.tick();
		const { collectChannelStatusIssues, buildChannelsTable } = await loadStatusScanRuntimeModule().then(({ statusScanRuntime }) => statusScanRuntime);
		const channelIssues = channelsStatus ? collectChannelStatusIssues(channelsStatus) : [];
		if (params.labels?.summarizingChannels) params.progress?.setLabel(params.labels.summarizingChannels);
		const channels = await buildChannelsTable(cfg, {
			showSecrets: params.showSecrets,
			sourceConfig,
			includeSetupFallbackPlugins: params.includeChannelSetupRuntimeFallback !== false,
			liveChannelStatus: channelsStatus
		});
		params.progress?.tick();
		return {
			channelsStatus,
			channelIssues,
			channels
		};
	})() : {
		channelsStatus: null,
		channelIssues: [],
		channels: {
			rows: [],
			details: []
		}
	};
	return {
		coldStart,
		hasConfiguredChannels,
		skipColdStartNetworkChecks: bootstrap.skipColdStartNetworkChecks,
		cfg,
		sourceConfig,
		secretDiagnostics,
		osSummary,
		tailscaleMode: bootstrap.tailscaleMode,
		tailscaleDns,
		tailscaleHttpsUrl,
		update,
		gatewaySnapshot,
		channelsStatus,
		channelIssues,
		channels,
		agentStatus
	};
}
async function resolveStatusSummaryFromOverview(params) {
	if (params.overview.skipColdStartNetworkChecks) return buildColdStartStatusSummary();
	return await loadStatusSummaryModule().then(({ getStatusSummary }) => getStatusSummary({
		config: params.overview.cfg,
		sourceConfig: params.overview.sourceConfig,
		includeChannelSummary: params.includeChannelSummary
	}));
}
//#endregion
export { resolveSharedMemoryStatusSnapshot as i, resolveStatusSummaryFromOverview as n, resolveMemoryPluginStatus as r, collectStatusScanOverview as t };
