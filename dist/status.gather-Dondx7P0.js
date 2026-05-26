import { d as resolveGatewayPort, s as resolveConfigPath, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { a as trimToUndefined } from "./credential-planner-DPeD90hR.js";
import "./credentials-BJ7jvgw3.js";
import { n as resolvePreferredOpenClawTmpDir, t as POSIX_OPENCLAW_TMP_DIR } from "./tmp-openclaw-dir-C60hWKdY.js";
import { r as createConfigIO } from "./io-DoswVvYe.js";
import { i as parseStrictPositiveInteger } from "./parse-finite-number-C3Woj8eC.js";
import { a as inspectPortConnections, l as formatPortDiagnostics, o as inspectPortUsage } from "./ports-C3z_VZTO.js";
import "./config-B6Oplu5W.js";
import { i as resolveGatewayService } from "./service-CTzdMGsq.js";
import { c as pickProbeHostForBind, o as normalizeListenerAddress, s as parsePortFromArgs } from "./shared-X3VACeu2.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-p6c0nawT.js";
import { r as resolveBestEffortGatewayBindHostForDisplay, t as inspectBestEffortPrimaryTailnetIPv4 } from "./network-discovery-display-BExMsOxF.js";
import { n as readGatewayRestartHandoffSync } from "./restart-handoff-BSak1pJo.js";
import JSON5 from "json5";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/logging/log-file-path.ts
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
function canUseNodeFs() {
	const getBuiltinModule = process.getBuiltinModule;
	if (typeof getBuiltinModule !== "function") return false;
	try {
		return getBuiltinModule("fs") !== void 0;
	} catch {
		return false;
	}
}
function formatLocalDate(date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function resolveDefaultRollingLogFile(date = /* @__PURE__ */ new Date()) {
	const logDir = canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
	return path.join(logDir, `${LOG_PREFIX}-${formatLocalDate(date)}${LOG_SUFFIX}`);
}
function resolveConfiguredLogFilePath(config) {
	return config?.logging?.file ?? resolveDefaultRollingLogFile();
}
//#endregion
//#region src/cli/daemon-cli/status.gather.ts
const gatewayProbeAuthModuleLoader = createLazyImportLoader(() => import("./probe-auth-WZzuL4lX.js"));
const daemonInspectModuleLoader = createLazyImportLoader(() => import("./inspect-BqXyMUBE.js"));
const launchdModuleLoader = createLazyImportLoader(() => import("./launchd-Dbdc0Ud-.js"));
const serviceAuditModuleLoader = createLazyImportLoader(() => import("./service-audit-CaSqIsjv.js"));
const gatewayTlsModuleLoader = createLazyImportLoader(() => import("./gateway-yorFnwpN.js"));
const daemonProbeModuleLoader = createLazyImportLoader(() => import("./probe-NjVYhrRQ.js"));
const restartHealthModuleLoader = createLazyImportLoader(() => import("./restart-health-BRIfNuAX.js"));
function loadGatewayProbeAuthModule() {
	return gatewayProbeAuthModuleLoader.load();
}
function loadDaemonInspectModule() {
	return daemonInspectModuleLoader.load();
}
function loadLaunchdModule() {
	return launchdModuleLoader.load();
}
function loadServiceAuditModule() {
	return serviceAuditModuleLoader.load();
}
function loadGatewayTlsModule() {
	return gatewayTlsModuleLoader.load();
}
function loadDaemonProbeModule() {
	return daemonProbeModuleLoader.load();
}
function loadRestartHealthModule() {
	return restartHealthModuleLoader.load();
}
function resolveSnapshotRuntimeConfig(snapshot) {
	if (!snapshot?.valid || !snapshot.runtimeConfig) return null;
	return snapshot.runtimeConfig;
}
function coerceStatusConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	return value;
}
function hasOwnKey(value, key) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, key));
}
function needsFullStatusConfigRead(raw, parsed) {
	return raw.includes("$include") || raw.includes("${") || hasOwnKey(parsed, "env");
}
async function readFastStatusConfig(configPath) {
	let raw;
	try {
		raw = await fs.readFile(configPath, "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON5.parse(raw);
	} catch (err) {
		return {
			summary: {
				path: configPath,
				exists: true,
				valid: false,
				issues: [{
					path: "",
					message: `JSON5 parse failed: ${String(err)}`
				}]
			},
			cfg: {},
			mode: "fast"
		};
	}
	if (needsFullStatusConfigRead(raw, parsed)) return null;
	const cfg = coerceStatusConfig(parsed);
	return {
		summary: {
			path: configPath,
			exists: true,
			valid: true,
			controlUi: cfg.gateway?.controlUi
		},
		cfg,
		mode: "fast"
	};
}
async function readFullStatusConfig(params) {
	const io = createConfigIO({
		env: params.env,
		configPath: params.configPath,
		pluginValidation: params.pluginValidation ?? "skip",
		logger: {
			error: () => {},
			warn: () => {}
		}
	});
	const snapshot = await io.readConfigFileSnapshot().catch(() => null);
	const cfg = resolveSnapshotRuntimeConfig(snapshot) ?? io.loadConfig();
	return {
		summary: {
			path: snapshot?.path ?? params.configPath,
			exists: snapshot?.exists ?? false,
			valid: snapshot?.valid ?? true,
			...snapshot?.issues?.length ? { issues: snapshot.issues } : {},
			...snapshot?.warnings?.length ? { warnings: snapshot.warnings } : {},
			controlUi: cfg.gateway?.controlUi
		},
		cfg,
		mode: "full"
	};
}
async function readStatusConfig(params) {
	return (params.deep ? null : await readFastStatusConfig(params.configPath)) ?? await readFullStatusConfig({
		env: params.env,
		configPath: params.configPath,
		pluginValidation: params.deep ? "full" : "skip"
	});
}
function appendProbeNote(existing, extra) {
	const values = [existing, extra].filter((value) => Boolean(value?.trim()));
	if (values.length === 0) return;
	return [...new Set(values)].join(" ");
}
function shouldReportPortUsage(status, rpcOk) {
	if (status !== "busy") return false;
	if (rpcOk === true) return false;
	return true;
}
function resolveCliStatusSummary(argv = process.argv) {
	const entrypoint = argv[1]?.trim();
	return {
		version: VERSION,
		...entrypoint ? { entrypoint } : {}
	};
}
async function loadDaemonConfigContext(serviceEnv, opts = {}) {
	const mergedDaemonEnv = {
		...process.env,
		...serviceEnv ?? void 0
	};
	const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
	const daemonConfigPath = resolveConfigPath(mergedDaemonEnv, resolveStateDir(mergedDaemonEnv));
	const sameConfigPath = cliConfigPath === daemonConfigPath;
	const cliConfigRead = await readStatusConfig({
		env: process.env,
		configPath: cliConfigPath,
		deep: opts.deep
	});
	const daemonConfigRead = sameConfigPath && (cliConfigRead.mode === "fast" || !serviceEnv) ? cliConfigRead : await readStatusConfig({
		env: mergedDaemonEnv,
		configPath: daemonConfigPath,
		deep: opts.deep
	});
	return {
		mergedDaemonEnv,
		cliCfg: cliConfigRead.cfg,
		daemonCfg: daemonConfigRead.cfg,
		cliConfigSummary: cliConfigRead.summary,
		daemonConfigSummary: daemonConfigRead.summary,
		configMismatch: cliConfigRead.summary.path !== daemonConfigRead.summary.path
	};
}
async function resolveGatewayStatusSummary(params) {
	const portFromArgs = parsePortFromArgs(params.commandProgramArguments);
	const daemonPort = portFromArgs ?? resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
	const portSource = portFromArgs ? "service args" : "env/config";
	const bindMode = params.daemonCfg.gateway?.bind ?? "loopback";
	const customBindHost = params.daemonCfg.gateway?.customBindHost;
	const { bindHost, warning: bindHostWarning } = await resolveBestEffortGatewayBindHostForDisplay({
		bindMode,
		customBindHost,
		warningPrefix: "Status is using fallback network details because interface discovery failed"
	});
	const { tailnetIPv4, warning: tailnetWarning } = inspectBestEffortPrimaryTailnetIPv4({ warningPrefix: "Status could not inspect tailnet addresses" });
	const probeHost = pickProbeHostForBind(bindMode, tailnetIPv4, customBindHost);
	const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
	const tlsEnabled = params.daemonCfg.gateway?.tls?.enabled === true;
	const probeUrl = probeUrlOverride ?? `${tlsEnabled ? "wss" : "ws"}://${probeHost}:${daemonPort}`;
	let probeNote = !probeUrlOverride && bindMode === "lan" ? `bind=lan listens on 0.0.0.0 (all interfaces); probing via ${probeHost}.` : !probeUrlOverride && bindMode === "loopback" ? "Loopback-only gateway; only local clients can connect." : void 0;
	probeNote = appendProbeNote(probeNote, bindHostWarning);
	probeNote = appendProbeNote(probeNote, tailnetWarning);
	return {
		gateway: {
			bindMode,
			bindHost,
			customBindHost,
			...tlsEnabled ? { tlsEnabled } : {},
			port: daemonPort,
			portSource,
			probeUrl,
			...probeNote ? { probeNote } : {}
		},
		daemonPort,
		cliPort: resolveGatewayPort(params.cliCfg, process.env),
		probeUrlOverride
	};
}
function toPortStatusSummary(diagnostics) {
	if (!diagnostics) return;
	return {
		port: diagnostics.port,
		status: diagnostics.status,
		listeners: diagnostics.listeners,
		hints: diagnostics.hints
	};
}
async function inspectDaemonPortStatuses(params) {
	const [portDiagnostics, portCliDiagnostics] = await Promise.all([inspectPortUsage(params.daemonPort).catch(() => null), params.cliPort !== params.daemonPort ? inspectPortUsage(params.cliPort).catch(() => null) : null]);
	return {
		portStatus: toPortStatusSummary(portDiagnostics),
		portCliStatus: toPortStatusSummary(portCliDiagnostics)
	};
}
async function inspectEstablishedGatewayClients(params) {
	if (params.deep !== true || params.gatewayMode === "remote") return;
	const result = await inspectPortConnections(params.daemonPort).catch(() => null);
	const establishedClients = result?.connections.filter((connection) => connection.direction !== "server");
	if (!result || !establishedClients || establishedClients.length === 0) return;
	return {
		port: result.port,
		established: establishedClients
	};
}
async function gatherDaemonStatus(opts) {
	const service = resolveGatewayService();
	const command = await service.readCommand(process.env).catch(() => null);
	const serviceEnv = command?.environment ? {
		...process.env,
		...command.environment
	} : process.env;
	const [loaded, runtime] = await Promise.all([service.isLoaded({ env: serviceEnv }).catch(() => false), service.readRuntime(serviceEnv).catch((err) => ({
		status: "unknown",
		detail: String(err)
	}))]);
	const restartHandoff = opts.deep ? readGatewayRestartHandoffSync(serviceEnv) : null;
	const configAudit = command ? await loadServiceAuditModule().then(({ auditGatewayServiceConfig }) => auditGatewayServiceConfig({
		env: process.env,
		command
	})) : {
		ok: true,
		issues: []
	};
	const { mergedDaemonEnv, cliCfg, daemonCfg, cliConfigSummary, daemonConfigSummary, configMismatch } = await loadDaemonConfigContext(command?.environment, { deep: opts.deep });
	const { gateway, daemonPort, cliPort, probeUrlOverride } = await resolveGatewayStatusSummary({
		cliCfg,
		daemonCfg,
		mergedDaemonEnv,
		commandProgramArguments: command?.programArguments,
		rpcUrlOverride: opts.rpc.url
	});
	const { portStatus, portCliStatus } = await inspectDaemonPortStatuses({
		daemonPort,
		cliPort
	});
	const establishedClients = await inspectEstablishedGatewayClients({
		daemonPort,
		deep: opts.deep,
		gatewayMode: daemonCfg.gateway?.mode
	});
	const extraServices = opts.deep ? await loadDaemonInspectModule().then(({ findExtraGatewayServices }) => findExtraGatewayServices(process.env, { deep: true })).catch(() => []) : [];
	const staleUpdateLaunchdJobs = opts.deep && process.platform === "darwin" ? await loadLaunchdModule().then(({ findStaleOpenClawUpdateLaunchdJobs }) => findStaleOpenClawUpdateLaunchdJobs()).catch(() => []) : [];
	const timeoutMs = parseStrictPositiveInteger(opts.rpc.timeout ?? void 0) ?? Math.max(1e4, daemonCfg.gateway?.handshakeTimeoutMs ?? 0);
	const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
	const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
	const tlsRuntime = shouldUseLocalTlsRuntime ? await loadGatewayTlsModule().then(({ loadGatewayTlsRuntime }) => loadGatewayTlsRuntime(daemonCfg.gateway?.tls)) : void 0;
	let daemonProbeAuth;
	let rpcAuthWarning;
	if (opts.probe) {
		const probeMode = daemonCfg.gateway?.mode === "remote" ? "remote" : "local";
		const probeAuthResolution = await loadGatewayProbeAuthModule().then(({ resolveGatewayProbeAuthSafeWithSecretInputs }) => resolveGatewayProbeAuthSafeWithSecretInputs({
			cfg: daemonCfg,
			mode: probeMode,
			env: mergedDaemonEnv,
			explicitAuth: {
				token: opts.rpc.token,
				password: opts.rpc.password
			}
		}));
		daemonProbeAuth = probeAuthResolution.auth;
		rpcAuthWarning = probeAuthResolution.warning;
	}
	const rpc = opts.probe ? await loadDaemonProbeModule().then(({ probeGatewayStatus }) => probeGatewayStatus({
		url: gateway.probeUrl,
		token: daemonProbeAuth?.token,
		password: daemonProbeAuth?.password,
		config: daemonCfg,
		tlsFingerprint: shouldUseLocalTlsRuntime && tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : void 0,
		preauthHandshakeTimeoutMs: daemonCfg.gateway?.handshakeTimeoutMs,
		timeoutMs,
		json: opts.rpc.json,
		requireRpc: opts.requireRpc,
		configPath: daemonConfigSummary.path
	})) : void 0;
	if (rpc?.ok) rpcAuthWarning = void 0;
	const health = opts.probe && loaded && rpc?.ok !== true ? await loadRestartHealthModule().then(({ inspectGatewayRestart }) => inspectGatewayRestart({
		service,
		port: daemonPort,
		env: serviceEnv
	})).catch(() => void 0) : void 0;
	const gatewayVersion = opts.probe ? (rpc && "server" in rpc ? rpc.server?.version : void 0) ?? (rpc && "version" in rpc ? rpc.version : void 0) ?? null : void 0;
	let lastError;
	if (loaded && runtime?.status === "running" && portStatus && portStatus.status !== "busy") lastError = await readLastGatewayErrorLine(mergedDaemonEnv) ?? void 0;
	return {
		cli: resolveCliStatusSummary(),
		logFile: resolveConfiguredLogFilePath(cliCfg),
		service: {
			label: service.label,
			loaded,
			loadedText: service.loadedText,
			notLoadedText: service.notLoadedText,
			command,
			runtime,
			configAudit,
			...restartHandoff ? { restartHandoff } : {},
			...staleUpdateLaunchdJobs.length > 0 ? { staleUpdateLaunchdJobs } : {}
		},
		config: {
			cli: cliConfigSummary,
			daemon: daemonConfigSummary,
			...configMismatch ? { mismatch: true } : {}
		},
		gateway: {
			...gateway,
			...opts.probe ? { version: gatewayVersion } : {}
		},
		port: portStatus,
		...portCliStatus ? { portCli: portCliStatus } : {},
		...establishedClients ? { connections: establishedClients } : {},
		lastError,
		...rpc ? { rpc: {
			...rpc,
			url: gateway.probeUrl,
			...rpcAuthWarning ? { authWarning: rpcAuthWarning } : {}
		} } : {},
		...health ? { health: {
			healthy: health.healthy,
			staleGatewayPids: health.staleGatewayPids
		} } : {},
		extraServices
	};
}
function renderPortDiagnosticsForCli(status, rpcOk) {
	if (!status.port || !shouldReportPortUsage(status.port.status, rpcOk)) return [];
	return formatPortDiagnostics({
		port: status.port.port,
		status: status.port.status,
		listeners: status.port.listeners,
		hints: status.port.hints
	});
}
function resolvePortListeningAddresses(status) {
	return Array.from(new Set(status.port?.listeners?.map((l) => l.address ? normalizeListenerAddress(l.address) : "").filter((v) => Boolean(v)) ?? []));
}
//#endregion
export { renderPortDiagnosticsForCli as n, resolvePortListeningAddresses as r, gatherDaemonStatus as t };
