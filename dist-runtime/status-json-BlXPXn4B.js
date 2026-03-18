import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import "./globals-B6h30oSy.js";
import { d as resolveGatewayPort, i as init_paths, s as resolveConfigPath, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { XS as hasPotentialConfiguredChannels } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import { n as runExec } from "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import { o as isSecureWebSocketUrl } from "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import "./runtime-parse-DJmitJVt.js";
import "./launchd-CYc1PBHk.js";
import "./service-BRvD766e.js";
import "./systemd-Ca2xqSN-.js";
import { t as probeGateway } from "./probe-XzGfgPsl.js";
import "./probe-auth-5wSPlf3K.js";
import { a as getNodeDaemonStatusSummary, d as resolveOsSummary, f as pickGatewaySelfPresence, i as getDaemonStatusSummary, n as resolveGatewayProbeAuthResolution, r as getAgentLocalStatuses, t as getStatusSummary } from "./status.summary-BkBvANsF.js";
import "./heartbeat-summary-CLoUvRc6.js";
import { h as resolveUpdateChannelDisplay, p as normalizeUpdateChannel } from "./update-check-C55miNMy.js";
import "./node-service-CLegCF40.js";
import { r as getUpdateCheckResult } from "./status.update-KDWYuIrV.js";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/commands/status.scan.fast-json.ts
init_paths();
let pluginRegistryModulePromise;
let configIoModulePromise;
let commandSecretTargetsModulePromise;
let commandSecretGatewayModulePromise;
let memorySearchModulePromise;
let statusScanDepsRuntimeModulePromise;
function loadPluginRegistryModule() {
	pluginRegistryModulePromise ??= import("./plugin-registry-3AZi8SvS.js");
	return pluginRegistryModulePromise;
}
function loadConfigIoModule() {
	configIoModulePromise ??= import("./io-BVxCrnx8.js");
	return configIoModulePromise;
}
function loadCommandSecretTargetsModule() {
	commandSecretTargetsModulePromise ??= import("./command-secret-targets-C0RcQSwG.js");
	return commandSecretTargetsModulePromise;
}
function loadCommandSecretGatewayModule() {
	commandSecretGatewayModulePromise ??= import("./command-secret-gateway-Cuh9Jov6.js");
	return commandSecretGatewayModulePromise;
}
function loadMemorySearchModule() {
	memorySearchModulePromise ??= import("./memory-search-CBqYrYAi.js");
	return memorySearchModulePromise;
}
function loadStatusScanDepsRuntimeModule() {
	statusScanDepsRuntimeModulePromise ??= import("./status.scan.deps.runtime-iHI6CBbI.js");
	return statusScanDepsRuntimeModulePromise;
}
function shouldSkipMissingConfigFastPath() {
	return process.env.VITEST === "true" || process.env.VITEST_POOL_ID !== void 0 || false;
}
function hasExplicitMemorySearchConfig(cfg, agentId) {
	if (cfg.agents?.defaults && Object.prototype.hasOwnProperty.call(cfg.agents.defaults, "memorySearch")) return true;
	return (Array.isArray(cfg.agents?.list) ? cfg.agents.list : []).some((agent) => agent?.id === agentId && Object.prototype.hasOwnProperty.call(agent, "memorySearch"));
}
function normalizeControlUiBasePath(basePath) {
	if (!basePath) return "";
	let normalized = basePath.trim();
	if (!normalized) return "";
	if (!normalized.startsWith("/")) normalized = `/${normalized}`;
	if (normalized === "/") return "";
	if (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	return normalized;
}
function trimToUndefined(value) {
	const trimmed = value?.trim();
	return trimmed ? trimmed : void 0;
}
function buildGatewayConnectionDetails(options) {
	const config = options.config;
	const configPath = options.configPath ?? resolveConfigPath(process.env, resolveStateDir(process.env));
	const isRemoteMode = config.gateway?.mode === "remote";
	const remote = isRemoteMode ? config.gateway?.remote : void 0;
	const tlsEnabled = config.gateway?.tls?.enabled === true;
	const localPort = resolveGatewayPort(config);
	const bindMode = config.gateway?.bind ?? "loopback";
	const localUrl = `${tlsEnabled ? "wss" : "ws"}://127.0.0.1:${localPort}`;
	const cliUrlOverride = typeof options.url === "string" && options.url.trim().length > 0 ? options.url.trim() : void 0;
	const envUrlOverride = cliUrlOverride ? void 0 : trimToUndefined(process.env.OPENCLAW_GATEWAY_URL) ?? trimToUndefined(process.env.CLAWDBOT_GATEWAY_URL);
	const urlOverride = cliUrlOverride ?? envUrlOverride;
	const remoteUrl = typeof remote?.url === "string" && remote.url.trim().length > 0 ? remote.url.trim() : void 0;
	const remoteMisconfigured = isRemoteMode && !urlOverride && !remoteUrl;
	const urlSourceHint = options.urlSource ?? (cliUrlOverride ? "cli" : envUrlOverride ? "env" : void 0);
	const url = urlOverride || remoteUrl || localUrl;
	const urlSource = urlOverride ? urlSourceHint === "env" ? "env OPENCLAW_GATEWAY_URL" : "cli --url" : remoteUrl ? "config gateway.remote.url" : remoteMisconfigured ? "missing gateway.remote.url (fallback local)" : "local loopback";
	const bindDetail = !urlOverride && !remoteUrl ? `Bind: ${bindMode}` : void 0;
	const remoteFallbackNote = remoteMisconfigured ? "Warn: gateway.mode=remote but gateway.remote.url is missing; set gateway.remote.url or switch gateway.mode=local." : void 0;
	if (!isSecureWebSocketUrl(url, { allowPrivateWs: process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS === "1" })) throw new Error([
		`SECURITY ERROR: Gateway URL "${url}" uses plaintext ws:// to a non-loopback address.`,
		"Both credentials and chat data would be exposed to network interception.",
		`Source: ${urlSource}`,
		`Config: ${configPath}`
	].join("\n"));
	return {
		url,
		urlSource,
		bindDetail,
		remoteFallbackNote,
		message: [
			`Gateway target: ${url}`,
			`Source: ${urlSource}`,
			`Config: ${configPath}`,
			bindDetail,
			remoteFallbackNote
		].filter(Boolean).join("\n")
	};
}
function resolveDefaultMemoryStorePath(agentId) {
	return path.join(resolveStateDir(process.env, os.homedir), "memory", `${agentId}.sqlite`);
}
function resolveMemoryPluginStatus(cfg) {
	if (!(cfg.plugins?.enabled !== false)) return {
		enabled: false,
		slot: null,
		reason: "plugins disabled"
	};
	const raw = typeof cfg.plugins?.slots?.memory === "string" ? cfg.plugins.slots.memory.trim() : "";
	if (raw && raw.toLowerCase() === "none") return {
		enabled: false,
		slot: null,
		reason: "plugins.slots.memory=\"none\""
	};
	return {
		enabled: true,
		slot: raw || "memory-core"
	};
}
async function resolveGatewayProbeSnapshot(params) {
	const gatewayConnection = buildGatewayConnectionDetails({ config: params.cfg });
	const isRemoteMode = params.cfg.gateway?.mode === "remote";
	const remoteUrlRaw = typeof params.cfg.gateway?.remote?.url === "string" ? params.cfg.gateway.remote.url : "";
	const remoteUrlMissing = isRemoteMode && !remoteUrlRaw.trim();
	const gatewayMode = isRemoteMode ? "remote" : "local";
	const gatewayProbeAuthResolution = resolveGatewayProbeAuthResolution(params.cfg);
	let gatewayProbeAuthWarning = gatewayProbeAuthResolution.warning;
	const gatewayProbe = remoteUrlMissing ? null : await probeGateway({
		url: gatewayConnection.url,
		auth: gatewayProbeAuthResolution.auth,
		timeoutMs: Math.min(params.opts.all ? 5e3 : 2500, params.opts.timeoutMs ?? 1e4),
		detailLevel: "presence"
	}).catch(() => null);
	if (gatewayProbeAuthWarning && gatewayProbe?.ok === false) {
		gatewayProbe.error = gatewayProbe.error ? `${gatewayProbe.error}; ${gatewayProbeAuthWarning}` : gatewayProbeAuthWarning;
		gatewayProbeAuthWarning = void 0;
	}
	return {
		gatewayConnection,
		remoteUrlMissing,
		gatewayMode,
		gatewayProbeAuth: gatewayProbeAuthResolution.auth,
		gatewayProbeAuthWarning,
		gatewayProbe
	};
}
async function resolveMemoryStatusSnapshot(params) {
	const { cfg, agentStatus, memoryPlugin } = params;
	if (!memoryPlugin.enabled || memoryPlugin.slot !== "memory-core") return null;
	const agentId = agentStatus.defaultId ?? "main";
	const explicitMemoryConfig = hasExplicitMemorySearchConfig(cfg, agentId);
	const defaultStorePath = resolveDefaultMemoryStorePath(agentId);
	if (!explicitMemoryConfig && !existsSync(defaultStorePath)) return null;
	const { resolveMemorySearchConfig } = await loadMemorySearchModule();
	const resolvedMemory = resolveMemorySearchConfig(cfg, agentId);
	if (!resolvedMemory) return null;
	if (!(hasExplicitMemorySearchConfig(cfg, agentId) || existsSync(resolvedMemory.store.path))) return null;
	const { getMemorySearchManager } = await loadStatusScanDepsRuntimeModule();
	const { manager } = await getMemorySearchManager({
		cfg,
		agentId,
		purpose: "status"
	});
	if (!manager) return null;
	try {
		await manager.probeVectorAvailability();
	} catch {}
	const status = manager.status();
	await manager.close?.().catch(() => {});
	return {
		agentId,
		...status
	};
}
async function readStatusSourceConfig() {
	if (!shouldSkipMissingConfigFastPath() && !existsSync(resolveConfigPath(process.env))) return {};
	const { readBestEffortConfig } = await loadConfigIoModule();
	return await readBestEffortConfig();
}
async function resolveStatusConfig(params) {
	if (!shouldSkipMissingConfigFastPath() && !existsSync(resolveConfigPath(process.env))) return {
		resolvedConfig: params.sourceConfig,
		diagnostics: []
	};
	const [{ resolveCommandSecretRefsViaGateway }, { getStatusCommandSecretTargetIds }] = await Promise.all([loadCommandSecretGatewayModule(), loadCommandSecretTargetsModule()]);
	return await resolveCommandSecretRefsViaGateway({
		config: params.sourceConfig,
		commandName: params.commandName,
		targetIds: getStatusCommandSecretTargetIds(),
		mode: "read_only_status"
	});
}
async function scanStatusJsonFast(opts, _runtime) {
	const loadedRaw = await readStatusSourceConfig();
	const { resolvedConfig: cfg, diagnostics: secretDiagnostics } = await resolveStatusConfig({
		sourceConfig: loadedRaw,
		commandName: "status --json"
	});
	if (hasPotentialConfiguredChannels(cfg)) {
		const { ensurePluginRegistryLoaded } = await loadPluginRegistryModule();
		ensurePluginRegistryLoaded({ scope: "configured-channels" });
	}
	const osSummary = resolveOsSummary();
	const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
	const updatePromise = getUpdateCheckResult({
		timeoutMs: opts.all ? 6500 : 2500,
		fetchGit: true,
		includeRegistry: true
	});
	const agentStatusPromise = getAgentLocalStatuses(cfg);
	const summaryPromise = getStatusSummary({
		config: cfg,
		sourceConfig: loadedRaw
	});
	const tailscaleDnsPromise = tailscaleMode === "off" ? Promise.resolve(null) : loadStatusScanDepsRuntimeModule().then(({ getTailnetHostname }) => getTailnetHostname((cmd, args) => runExec(cmd, args, {
		timeoutMs: 1200,
		maxBuffer: 2e5
	}))).catch(() => null);
	const gatewayProbePromise = resolveGatewayProbeSnapshot({
		cfg,
		opts
	});
	const [tailscaleDns, update, agentStatus, gatewaySnapshot, summary] = await Promise.all([
		tailscaleDnsPromise,
		updatePromise,
		agentStatusPromise,
		gatewayProbePromise,
		summaryPromise
	]);
	const tailscaleHttpsUrl = tailscaleMode !== "off" && tailscaleDns ? `https://${tailscaleDns}${normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath)}` : null;
	const { gatewayConnection, remoteUrlMissing, gatewayMode, gatewayProbeAuth, gatewayProbeAuthWarning, gatewayProbe } = gatewaySnapshot;
	const gatewayReachable = gatewayProbe?.ok === true;
	const gatewaySelf = gatewayProbe?.presence ? pickGatewaySelfPresence(gatewayProbe.presence) : null;
	const memoryPlugin = resolveMemoryPluginStatus(cfg);
	return {
		cfg,
		sourceConfig: loadedRaw,
		secretDiagnostics,
		osSummary,
		tailscaleMode,
		tailscaleDns,
		tailscaleHttpsUrl,
		update,
		gatewayConnection,
		remoteUrlMissing,
		gatewayMode,
		gatewayProbeAuth,
		gatewayProbeAuthWarning,
		gatewayProbe,
		gatewayReachable,
		gatewaySelf,
		channelIssues: [],
		agentStatus,
		channels: {
			rows: [],
			details: []
		},
		summary,
		memory: await resolveMemoryStatusSnapshot({
			cfg,
			agentStatus,
			memoryPlugin
		}),
		memoryPlugin
	};
}
//#endregion
//#region src/commands/status-json.ts
let providerUsagePromise;
let securityAuditModulePromise;
let gatewayCallModulePromise;
function loadProviderUsage() {
	providerUsagePromise ??= import("./provider-usage-cRiYVb8O.js");
	return providerUsagePromise;
}
function loadSecurityAuditModule() {
	securityAuditModulePromise ??= import("./audit.runtime-BTDWEQFh.js");
	return securityAuditModulePromise;
}
function loadGatewayCallModule() {
	gatewayCallModulePromise ??= import("./call-CDkmhXB8.js");
	return gatewayCallModulePromise;
}
async function statusJsonCommand(opts, runtime) {
	const scan = await scanStatusJsonFast({
		timeoutMs: opts.timeoutMs,
		all: opts.all
	}, runtime);
	const securityAudit = await loadSecurityAuditModule().then(({ runSecurityAudit }) => runSecurityAudit({
		config: scan.cfg,
		sourceConfig: scan.sourceConfig,
		deep: false,
		includeFilesystem: true,
		includeChannelSecurity: true
	}));
	const usage = opts.usage ? await loadProviderUsage().then(({ loadProviderUsageSummary }) => loadProviderUsageSummary({ timeoutMs: opts.timeoutMs })) : void 0;
	const gatewayCall = opts.deep ? await loadGatewayCallModule().then((mod) => mod.callGateway) : null;
	const health = gatewayCall != null ? await gatewayCall({
		method: "health",
		params: { probe: true },
		timeoutMs: opts.timeoutMs,
		config: scan.cfg
	}).catch(() => void 0) : void 0;
	const lastHeartbeat = gatewayCall != null && scan.gatewayReachable ? await gatewayCall({
		method: "last-heartbeat",
		params: {},
		timeoutMs: opts.timeoutMs,
		config: scan.cfg
	}).catch(() => null) : null;
	const [daemon, nodeDaemon] = await Promise.all([getDaemonStatusSummary(), getNodeDaemonStatusSummary()]);
	const channelInfo = resolveUpdateChannelDisplay({
		configChannel: normalizeUpdateChannel(scan.cfg.update?.channel),
		installKind: scan.update.installKind,
		gitTag: scan.update.git?.tag ?? null,
		gitBranch: scan.update.git?.branch ?? null
	});
	runtime.log(JSON.stringify({
		...scan.summary,
		os: scan.osSummary,
		update: scan.update,
		updateChannel: channelInfo.channel,
		updateChannelSource: channelInfo.source,
		memory: scan.memory,
		memoryPlugin: scan.memoryPlugin,
		gateway: {
			mode: scan.gatewayMode,
			url: scan.gatewayConnection.url,
			urlSource: scan.gatewayConnection.urlSource,
			misconfigured: scan.remoteUrlMissing,
			reachable: scan.gatewayReachable,
			connectLatencyMs: scan.gatewayProbe?.connectLatencyMs ?? null,
			self: scan.gatewaySelf,
			error: scan.gatewayProbe?.error ?? null,
			authWarning: scan.gatewayProbeAuthWarning ?? null
		},
		gatewayService: daemon,
		nodeService: nodeDaemon,
		agents: scan.agentStatus,
		securityAudit,
		secretDiagnostics: scan.secretDiagnostics,
		...health || usage || lastHeartbeat ? {
			health,
			usage,
			lastHeartbeat
		} : {}
	}, null, 2));
}
//#endregion
export { statusJsonCommand };
