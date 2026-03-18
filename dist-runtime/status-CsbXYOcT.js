import { m as getResolvedLoggerSettings } from "./globals-B6h30oSy.js";
import { d as resolveGatewayPort, s as resolveConfigPath, v as resolveStateDir } from "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme, r as isRich, t as colorize } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import { C as shortenHomePath, d as init_utils, w as sleep } from "./utils-BiUV1eIQ.js";
import { Ib as createConfigIO, qd as loadGatewayTlsRuntime, sd as resolveControlUiLinks, tn as withProgress, zd as callGateway } from "./auth-profiles-DAOR1fRn.js";
import { En as GATEWAY_CLIENT_NAMES, Tn as GATEWAY_CLIENT_MODES } from "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { T as trimToUndefined, g as isGatewaySecretRefUnavailableError } from "./config-DZ3oWznn.js";
import { f as resolveGatewayBindHost, g as pickPrimaryTailnetIPv4 } from "./device-metadata-normalization-a2oQYp64.js";
import { a as inspectPortUsage, c as formatPortDiagnostics, s as classifyPortListener } from "./ports-D4BnBb9r.js";
import { f as resolveGatewaySystemdServiceName, l as resolveGatewayLaunchAgentLabel, x as parseStrictPositiveInteger } from "./constants-C8ub4F0Y.js";
import { a as isWSLEnv } from "./fetch-wLdC1F30.js";
import { o as killProcessTree } from "./cmd-argv-DFVIyCDr.js";
import { c as resolveGatewayLogPaths } from "./launchd-CYc1PBHk.js";
import { n as resolveGatewayService } from "./service-BRvD766e.js";
import { a as normalizeListenerAddress, d as safeDaemonEnv, i as filterDaemonEnv, l as renderRuntimeHints, o as parsePortFromArgs, s as pickProbeHostForBind, t as createCliStatusTextStyles, u as resolveRuntimeStatusColor } from "./shared-CCPEqzJi.js";
import { i as auditGatewayServiceConfig, n as renderSystemdUnavailableHints, t as isSystemdUnavailableDetail, u as formatRuntimeStatus } from "./systemd-hints-CyeYGmDG.js";
import { t as probeGateway } from "./probe-XzGfgPsl.js";
import { t as formatConfigIssueLine } from "./issue-format-CBjhFckx.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-Dt1yQ2p8.js";
import { n as renderGatewayServiceCleanupHints, t as findExtraGatewayServices } from "./inspect-DCmCrH4y.js";
import { r as resolveGatewayProbeAuthWithSecretInputs } from "./probe-auth-5wSPlf3K.js";
//#region src/cli/daemon-cli/restart-health.ts
init_utils();
const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(6e4 / 500);
function hasListenerAttributionGap(portUsage) {
	if (portUsage.status !== "busy" || portUsage.listeners.length > 0) return false;
	if (portUsage.errors?.length) return true;
	return portUsage.hints.some((hint) => hint.includes("process details are unavailable"));
}
function listenerOwnedByRuntimePid(params) {
	return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
}
function looksLikeAuthClose(code, reason) {
	if (code !== 1008) return false;
	const normalized = (reason ?? "").toLowerCase();
	return normalized.includes("auth") || normalized.includes("token") || normalized.includes("password") || normalized.includes("scope") || normalized.includes("role");
}
async function confirmGatewayReachable(port) {
	const token = process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || void 0;
	const password = process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || void 0;
	const probe = await probeGateway({
		url: `ws://127.0.0.1:${port}`,
		auth: token || password ? {
			token,
			password
		} : void 0,
		timeoutMs: 3e3,
		includeDetails: false
	});
	return probe.ok || looksLikeAuthClose(probe.close?.code, probe.close?.reason);
}
async function inspectGatewayPortHealth(port) {
	let portUsage;
	try {
		portUsage = await inspectPortUsage(port);
	} catch (err) {
		portUsage = {
			port,
			status: "unknown",
			listeners: [],
			hints: [],
			errors: [String(err)]
		};
	}
	let healthy = false;
	if (portUsage.status === "busy") try {
		healthy = await confirmGatewayReachable(port);
	} catch {}
	return {
		portUsage,
		healthy
	};
}
async function inspectGatewayRestart(params) {
	const env = params.env ?? process.env;
	let runtime = { status: "unknown" };
	try {
		runtime = await params.service.readRuntime(env);
	} catch (err) {
		runtime = {
			status: "unknown",
			detail: String(err)
		};
	}
	let portUsage;
	try {
		portUsage = await inspectPortUsage(params.port);
	} catch (err) {
		portUsage = {
			port: params.port,
			status: "unknown",
			listeners: [],
			hints: [],
			errors: [String(err)]
		};
	}
	if (portUsage.status === "busy" && runtime.status !== "running") try {
		if (await confirmGatewayReachable(params.port)) return {
			runtime,
			portUsage,
			healthy: true,
			staleGatewayPids: []
		};
	} catch {}
	const gatewayListeners = portUsage.status === "busy" ? portUsage.listeners.filter((listener) => classifyPortListener(listener, params.port) === "gateway") : [];
	const fallbackListenerPids = params.includeUnknownListenersAsStale && process.platform === "win32" && runtime.status !== "running" && portUsage.status === "busy" ? portUsage.listeners.filter((listener) => classifyPortListener(listener, params.port) === "unknown").map((listener) => listener.pid).filter((pid) => Number.isFinite(pid)) : [];
	const running = runtime.status === "running";
	const runtimePid = runtime.pid;
	const listenerAttributionGap = hasListenerAttributionGap(portUsage);
	const ownsPort = runtimePid != null ? portUsage.listeners.some((listener) => listenerOwnedByRuntimePid({
		listener,
		runtimePid
	})) || listenerAttributionGap : gatewayListeners.length > 0 || listenerAttributionGap;
	let healthy = running && ownsPort;
	if (!healthy && running && portUsage.status === "busy") try {
		healthy = await confirmGatewayReachable(params.port);
	} catch {}
	const staleGatewayPids = Array.from(new Set([...gatewayListeners.filter((listener) => Number.isFinite(listener.pid)).filter((listener) => {
		if (!running) return true;
		if (runtimePid == null) return false;
		return !listenerOwnedByRuntimePid({
			listener,
			runtimePid
		});
	}).map((listener) => listener.pid), ...fallbackListenerPids.filter((pid) => runtime.pid == null || pid !== runtime.pid || !running)]));
	return {
		runtime,
		portUsage,
		healthy,
		staleGatewayPids
	};
}
async function waitForGatewayHealthyRestart(params) {
	const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
	const delayMs = params.delayMs ?? 500;
	let snapshot = await inspectGatewayRestart({
		service: params.service,
		port: params.port,
		env: params.env,
		includeUnknownListenersAsStale: params.includeUnknownListenersAsStale
	});
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (snapshot.healthy) return snapshot;
		if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") return snapshot;
		await sleep(delayMs);
		snapshot = await inspectGatewayRestart({
			service: params.service,
			port: params.port,
			env: params.env,
			includeUnknownListenersAsStale: params.includeUnknownListenersAsStale
		});
	}
	return snapshot;
}
async function waitForGatewayHealthyListener(params) {
	const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
	const delayMs = params.delayMs ?? 500;
	let snapshot = await inspectGatewayPortHealth(params.port);
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (snapshot.healthy) return snapshot;
		await sleep(delayMs);
		snapshot = await inspectGatewayPortHealth(params.port);
	}
	return snapshot;
}
function renderPortUsageDiagnostics(snapshot) {
	const lines = [];
	if (snapshot.portUsage.status === "busy") lines.push(...formatPortDiagnostics(snapshot.portUsage));
	else lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
	if (snapshot.portUsage.errors?.length) lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
	return lines;
}
function renderRestartDiagnostics(snapshot) {
	const lines = [];
	const runtimeSummary = [
		snapshot.runtime.status ? `status=${snapshot.runtime.status}` : null,
		snapshot.runtime.state ? `state=${snapshot.runtime.state}` : null,
		snapshot.runtime.pid != null ? `pid=${snapshot.runtime.pid}` : null,
		snapshot.runtime.lastExitStatus != null ? `lastExit=${snapshot.runtime.lastExitStatus}` : null
	].filter(Boolean).join(", ");
	if (runtimeSummary) lines.push(`Service runtime: ${runtimeSummary}`);
	lines.push(...renderPortUsageDiagnostics(snapshot));
	return lines;
}
function renderGatewayPortHealthDiagnostics(snapshot) {
	return renderPortUsageDiagnostics(snapshot);
}
async function terminateStaleGatewayPids(pids) {
	const targets = Array.from(new Set(pids.filter((pid) => Number.isFinite(pid) && pid > 0)));
	for (const pid of targets) killProcessTree(pid, { graceMs: 300 });
	if (targets.length > 0) await sleep(500);
	return targets;
}
//#endregion
//#region src/cli/daemon-cli/probe.ts
async function probeGatewayStatus(opts) {
	try {
		await withProgress({
			label: "Checking gateway status...",
			indeterminate: true,
			enabled: opts.json !== true
		}, async () => await callGateway({
			url: opts.url,
			token: opts.token,
			password: opts.password,
			tlsFingerprint: opts.tlsFingerprint,
			method: "status",
			timeoutMs: opts.timeoutMs,
			clientName: GATEWAY_CLIENT_NAMES.CLI,
			mode: GATEWAY_CLIENT_MODES.CLI,
			...opts.configPath ? { configPath: opts.configPath } : {}
		}));
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/cli/daemon-cli/status.gather.ts
function shouldReportPortUsage(status, rpcOk) {
	if (status !== "busy") return false;
	if (rpcOk === true) return false;
	return true;
}
function parseGatewaySecretRefPathFromError(error) {
	return isGatewaySecretRefUnavailableError(error) ? error.path : null;
}
async function loadDaemonConfigContext(serviceEnv) {
	const mergedDaemonEnv = {
		...process.env,
		...serviceEnv ?? void 0
	};
	const cliConfigPath = resolveConfigPath(process.env, resolveStateDir(process.env));
	const daemonConfigPath = resolveConfigPath(mergedDaemonEnv, resolveStateDir(mergedDaemonEnv));
	const cliIO = createConfigIO({
		env: process.env,
		configPath: cliConfigPath
	});
	const daemonIO = createConfigIO({
		env: mergedDaemonEnv,
		configPath: daemonConfigPath
	});
	const [cliSnapshot, daemonSnapshot] = await Promise.all([cliIO.readConfigFileSnapshot().catch(() => null), daemonIO.readConfigFileSnapshot().catch(() => null)]);
	const cliCfg = cliIO.loadConfig();
	const daemonCfg = daemonIO.loadConfig();
	const cliConfigSummary = {
		path: cliSnapshot?.path ?? cliConfigPath,
		exists: cliSnapshot?.exists ?? false,
		valid: cliSnapshot?.valid ?? true,
		...cliSnapshot?.issues?.length ? { issues: cliSnapshot.issues } : {},
		controlUi: cliCfg.gateway?.controlUi
	};
	const daemonConfigSummary = {
		path: daemonSnapshot?.path ?? daemonConfigPath,
		exists: daemonSnapshot?.exists ?? false,
		valid: daemonSnapshot?.valid ?? true,
		...daemonSnapshot?.issues?.length ? { issues: daemonSnapshot.issues } : {},
		controlUi: daemonCfg.gateway?.controlUi
	};
	return {
		mergedDaemonEnv,
		cliCfg,
		daemonCfg,
		cliConfigSummary,
		daemonConfigSummary,
		configMismatch: cliConfigSummary.path !== daemonConfigSummary.path
	};
}
async function resolveGatewayStatusSummary(params) {
	const portFromArgs = parsePortFromArgs(params.commandProgramArguments);
	const daemonPort = portFromArgs ?? resolveGatewayPort(params.daemonCfg, params.mergedDaemonEnv);
	const portSource = portFromArgs ? "service args" : "env/config";
	const bindMode = params.daemonCfg.gateway?.bind ?? "loopback";
	const customBindHost = params.daemonCfg.gateway?.customBindHost;
	const bindHost = await resolveGatewayBindHost(bindMode, customBindHost);
	const probeHost = pickProbeHostForBind(bindMode, pickPrimaryTailnetIPv4(), customBindHost);
	const probeUrlOverride = trimToUndefined(params.rpcUrlOverride) ?? null;
	const scheme = params.daemonCfg.gateway?.tls?.enabled === true ? "wss" : "ws";
	const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
	const probeNote = !probeUrlOverride && bindMode === "lan" ? `bind=lan listens on 0.0.0.0 (all interfaces); probing via ${probeHost}.` : !probeUrlOverride && bindMode === "loopback" ? "Loopback-only gateway; only local clients can connect." : void 0;
	return {
		gateway: {
			bindMode,
			bindHost,
			customBindHost,
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
	const configAudit = await auditGatewayServiceConfig({
		env: process.env,
		command
	});
	const { mergedDaemonEnv, cliCfg, daemonCfg, cliConfigSummary, daemonConfigSummary, configMismatch } = await loadDaemonConfigContext(command?.environment);
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
	const extraServices = await findExtraGatewayServices(process.env, { deep: Boolean(opts.deep) }).catch(() => []);
	const timeoutMs = parseStrictPositiveInteger(opts.rpc.timeout ?? "10000") ?? 1e4;
	const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
	const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
	const tlsRuntime = shouldUseLocalTlsRuntime ? await loadGatewayTlsRuntime(daemonCfg.gateway?.tls) : void 0;
	let daemonProbeAuth;
	let rpcAuthWarning;
	if (opts.probe) try {
		daemonProbeAuth = await resolveGatewayProbeAuthWithSecretInputs({
			cfg: daemonCfg,
			mode: daemonCfg.gateway?.mode === "remote" ? "remote" : "local",
			env: mergedDaemonEnv,
			explicitAuth: {
				token: opts.rpc.token,
				password: opts.rpc.password
			}
		});
	} catch (error) {
		const refPath = parseGatewaySecretRefPathFromError(error);
		if (!refPath) throw error;
		daemonProbeAuth = void 0;
		rpcAuthWarning = `${refPath} SecretRef is unavailable in this command path; probing without configured auth credentials.`;
	}
	const rpc = opts.probe ? await probeGatewayStatus({
		url: gateway.probeUrl,
		token: daemonProbeAuth?.token,
		password: daemonProbeAuth?.password,
		tlsFingerprint: shouldUseLocalTlsRuntime && tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : void 0,
		timeoutMs,
		json: opts.rpc.json,
		configPath: daemonConfigSummary.path
	}) : void 0;
	if (rpc?.ok) rpcAuthWarning = void 0;
	const health = opts.probe && loaded ? await inspectGatewayRestart({
		service,
		port: daemonPort,
		env: serviceEnv
	}).catch(() => void 0) : void 0;
	let lastError;
	if (loaded && runtime?.status === "running" && portStatus && portStatus.status !== "busy") lastError = await readLastGatewayErrorLine(mergedDaemonEnv) ?? void 0;
	return {
		service: {
			label: service.label,
			loaded,
			loadedText: service.loadedText,
			notLoadedText: service.notLoadedText,
			command,
			runtime,
			configAudit
		},
		config: {
			cli: cliConfigSummary,
			daemon: daemonConfigSummary,
			...configMismatch ? { mismatch: true } : {}
		},
		gateway,
		port: portStatus,
		...portCliStatus ? { portCli: portCliStatus } : {},
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
//#region src/cli/daemon-cli/status.print.ts
init_runtime();
init_theme();
init_utils();
function sanitizeDaemonStatusForJson(status) {
	const command = status.service.command;
	if (!command?.environment) return status;
	const safeEnv = filterDaemonEnv(command.environment);
	const nextCommand = {
		...command,
		environment: Object.keys(safeEnv).length > 0 ? safeEnv : void 0
	};
	return {
		...status,
		service: {
			...status.service,
			command: nextCommand
		}
	};
}
function printDaemonStatus(status, opts) {
	if (opts.json) {
		const sanitized = sanitizeDaemonStatusForJson(status);
		defaultRuntime.log(JSON.stringify(sanitized, null, 2));
		return;
	}
	const { rich, label, accent, infoText, okText, warnText, errorText } = createCliStatusTextStyles();
	const spacer = () => defaultRuntime.log("");
	const { service, rpc, extraServices } = status;
	const serviceStatus = service.loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
	defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
	try {
		const logFile = getResolvedLoggerSettings().file;
		defaultRuntime.log(`${label("File logs:")} ${infoText(shortenHomePath(logFile))}`);
	} catch {}
	if (service.command?.programArguments?.length) defaultRuntime.log(`${label("Command:")} ${infoText(service.command.programArguments.join(" "))}`);
	if (service.command?.sourcePath) defaultRuntime.log(`${label("Service file:")} ${infoText(shortenHomePath(service.command.sourcePath))}`);
	if (service.command?.workingDirectory) defaultRuntime.log(`${label("Working dir:")} ${infoText(shortenHomePath(service.command.workingDirectory))}`);
	const daemonEnvLines = safeDaemonEnv(service.command?.environment);
	if (daemonEnvLines.length > 0) defaultRuntime.log(`${label("Service env:")} ${daemonEnvLines.join(" ")}`);
	spacer();
	if (service.configAudit?.issues.length) {
		defaultRuntime.error(warnText("Service config looks out of date or non-standard."));
		for (const issue of service.configAudit.issues) {
			const detail = issue.detail ? ` (${issue.detail})` : "";
			defaultRuntime.error(`${warnText("Service config issue:")} ${issue.message}${detail}`);
		}
		defaultRuntime.error(warnText(`Recommendation: run "${formatCliCommand("openclaw doctor")}" (or "${formatCliCommand("openclaw doctor --repair")}").`));
	}
	if (status.config) {
		const cliCfg = `${shortenHomePath(status.config.cli.path)}${status.config.cli.exists ? "" : " (missing)"}${status.config.cli.valid ? "" : " (invalid)"}`;
		defaultRuntime.log(`${label("Config (cli):")} ${infoText(cliCfg)}`);
		if (!status.config.cli.valid && status.config.cli.issues?.length) for (const issue of status.config.cli.issues.slice(0, 5)) defaultRuntime.error(`${errorText("Config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`);
		if (status.config.daemon) {
			const daemonCfg = `${shortenHomePath(status.config.daemon.path)}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
			defaultRuntime.log(`${label("Config (service):")} ${infoText(daemonCfg)}`);
			if (!status.config.daemon.valid && status.config.daemon.issues?.length) for (const issue of status.config.daemon.issues.slice(0, 5)) defaultRuntime.error(`${errorText("Service config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`);
		}
		if (status.config.mismatch) {
			defaultRuntime.error(errorText("Root cause: CLI and service are using different config paths (likely a profile/state-dir mismatch)."));
			defaultRuntime.error(errorText(`Fix: rerun \`${formatCliCommand("openclaw gateway install --force")}\` from the same --profile / OPENCLAW_STATE_DIR you expect.`));
		}
		spacer();
	}
	if (status.gateway) {
		const bindHost = status.gateway.bindHost ?? "n/a";
		defaultRuntime.log(`${label("Gateway:")} bind=${infoText(status.gateway.bindMode)} (${infoText(bindHost)}), port=${infoText(String(status.gateway.port))} (${infoText(status.gateway.portSource)})`);
		defaultRuntime.log(`${label("Probe target:")} ${infoText(status.gateway.probeUrl)}`);
		if (!(status.config?.daemon?.controlUi?.enabled ?? true)) defaultRuntime.log(`${label("Dashboard:")} ${warnText("disabled")}`);
		else {
			const links = resolveControlUiLinks({
				port: status.gateway.port,
				bind: status.gateway.bindMode,
				customBindHost: status.gateway.customBindHost,
				basePath: status.config?.daemon?.controlUi?.basePath
			});
			defaultRuntime.log(`${label("Dashboard:")} ${infoText(links.httpUrl)}`);
		}
		if (status.gateway.probeNote) defaultRuntime.log(`${label("Probe note:")} ${infoText(status.gateway.probeNote)}`);
		spacer();
	}
	const runtimeLine = formatRuntimeStatus(service.runtime);
	if (runtimeLine) {
		const runtimeColor = resolveRuntimeStatusColor(service.runtime?.status);
		defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
	}
	if (rpc && !rpc.ok && service.loaded && service.runtime?.status === "running") defaultRuntime.log(warnText("Warm-up: launch agents can take a few seconds. Try again shortly."));
	if (rpc) {
		if (rpc.ok) defaultRuntime.log(`${label("RPC probe:")} ${okText("ok")}`);
		else {
			defaultRuntime.error(`${label("RPC probe:")} ${errorText("failed")}`);
			if (rpc.authWarning) defaultRuntime.error(`${label("RPC auth:")} ${warnText(rpc.authWarning)}`);
			if (rpc.url) defaultRuntime.error(`${label("RPC target:")} ${rpc.url}`);
			const lines = String(rpc.error ?? "unknown").split(/\r?\n/).filter(Boolean);
			for (const line of lines.slice(0, 12)) defaultRuntime.error(`  ${errorText(line)}`);
		}
		spacer();
	}
	if (status.health && status.health.staleGatewayPids.length > 0 && service.runtime?.status === "running" && typeof service.runtime.pid === "number") {
		defaultRuntime.error(errorText(`Gateway runtime PID does not own the listening port. Other gateway process(es) are listening: ${status.health.staleGatewayPids.join(", ")}`));
		defaultRuntime.error(errorText(`Fix: run ${formatCliCommand("openclaw gateway restart")} and re-check with ${formatCliCommand("openclaw gateway status --deep")}.`));
		spacer();
	}
	if (process.platform === "linux" && isSystemdUnavailableDetail(service.runtime?.detail)) {
		defaultRuntime.error(errorText("systemd user services unavailable."));
		for (const hint of renderSystemdUnavailableHints({ wsl: isWSLEnv() })) defaultRuntime.error(errorText(hint));
		spacer();
	}
	if (service.runtime?.missingUnit) {
		defaultRuntime.error(errorText("Service unit not found."));
		for (const hint of renderRuntimeHints(service.runtime)) defaultRuntime.error(errorText(hint));
	} else if (service.loaded && service.runtime?.status === "stopped") {
		defaultRuntime.error(errorText("Service is loaded but not running (likely exited immediately)."));
		for (const hint of renderRuntimeHints(service.runtime, service.command?.environment ?? process.env)) defaultRuntime.error(errorText(hint));
		spacer();
	}
	if (service.runtime?.cachedLabel) {
		const labelValue = resolveGatewayLaunchAgentLabel((service.command?.environment ?? process.env).OPENCLAW_PROFILE);
		defaultRuntime.error(errorText(`LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${labelValue}`));
		defaultRuntime.error(errorText(`Then reinstall: ${formatCliCommand("openclaw gateway install")}`));
		spacer();
	}
	for (const line of renderPortDiagnosticsForCli(status, rpc?.ok)) defaultRuntime.error(errorText(line));
	if (status.port) {
		const addrs = resolvePortListeningAddresses(status);
		if (addrs.length > 0) defaultRuntime.log(`${label("Listening:")} ${infoText(addrs.join(", "))}`);
	}
	if (status.portCli && status.portCli.port !== status.port?.port) defaultRuntime.log(`${label("Note:")} CLI config resolves gateway port=${status.portCli.port} (${status.portCli.status}).`);
	if (service.loaded && service.runtime?.status === "running" && status.port && status.port.status !== "busy") {
		defaultRuntime.error(errorText(`Gateway port ${status.port.port} is not listening (service appears running).`));
		if (status.lastError) defaultRuntime.error(`${errorText("Last gateway error:")} ${status.lastError}`);
		if (process.platform === "linux") {
			const unit = resolveGatewaySystemdServiceName((service.command?.environment ?? process.env).OPENCLAW_PROFILE);
			defaultRuntime.error(errorText(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`));
		} else if (process.platform === "darwin") {
			const logs = resolveGatewayLogPaths(service.command?.environment ?? process.env);
			defaultRuntime.error(`${errorText("Logs:")} ${shortenHomePath(logs.stdoutPath)}`);
			defaultRuntime.error(`${errorText("Errors:")} ${shortenHomePath(logs.stderrPath)}`);
		}
		spacer();
	}
	if (extraServices.length > 0) {
		defaultRuntime.error(errorText("Other gateway-like services detected (best effort):"));
		for (const svc of extraServices) defaultRuntime.error(`- ${errorText(svc.label)} (${svc.scope}, ${svc.detail})`);
		for (const hint of renderGatewayServiceCleanupHints()) defaultRuntime.error(`${errorText("Cleanup hint:")} ${hint}`);
		spacer();
	}
	if (extraServices.length > 0) {
		defaultRuntime.error(errorText("Recommendation: run a single gateway per machine for most setups. One gateway supports multiple agents (see docs: /gateway#multiple-gateways-same-host)."));
		defaultRuntime.error(errorText("If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host)."));
		spacer();
	}
	defaultRuntime.log(`${label("Troubles:")} run ${formatCliCommand("openclaw status")}`);
	defaultRuntime.log(`${label("Troubleshooting:")} https://docs.openclaw.ai/troubleshooting`);
}
//#endregion
//#region src/cli/daemon-cli/status.ts
init_runtime();
init_theme();
async function runDaemonStatus(opts) {
	try {
		if (opts.requireRpc && !opts.probe) {
			defaultRuntime.error("Gateway status failed: --require-rpc cannot be used with --no-probe.");
			defaultRuntime.exit(1);
			return;
		}
		const status = await gatherDaemonStatus({
			rpc: opts.rpc,
			probe: Boolean(opts.probe),
			deep: Boolean(opts.deep)
		});
		printDaemonStatus(status, { json: Boolean(opts.json) });
		if (opts.requireRpc && !status.rpc?.ok) defaultRuntime.exit(1);
	} catch (err) {
		const rich = isRich();
		defaultRuntime.error(colorize(rich, theme.error, `Gateway status failed: ${String(err)}`));
		defaultRuntime.exit(1);
	}
}
//#endregion
export { terminateStaleGatewayPids as a, renderRestartDiagnostics as i, DEFAULT_RESTART_HEALTH_ATTEMPTS as n, waitForGatewayHealthyListener as o, renderGatewayPortHealthDiagnostics as r, waitForGatewayHealthyRestart as s, runDaemonStatus as t };
