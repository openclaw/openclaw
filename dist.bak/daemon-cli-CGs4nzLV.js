import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { d as resolveIsNixMode, g as resolveStateDir, o as resolveConfigPath, u as resolveGatewayPort } from "./paths-B4BZAPZh.js";
import { B as theme, C as sleep, R as colorize, S as shortenHomePath, U as getResolvedLoggerSettings, z as isRich } from "./utils-BKDT474X.js";
import { f as defaultRuntime } from "./subsystem-LTWJBEIv.js";
import { Gt as writeConfigFile, Rt as createConfigIO, Vt as readConfigFileSnapshot, zt as loadConfig } from "./model-selection-DILdVnl8.js";
import { t as formatCliCommand } from "./command-format-ChfKqObn.js";
import { h as GATEWAY_CLIENT_NAMES, m as GATEWAY_CLIENT_MODES } from "./message-channel-C0KMGsnJ.js";
import { n as pickPrimaryTailnetIPv4 } from "./tailnet-kbXXH7kK.js";
import { d as resolveGatewayBindHost } from "./ws-zZ6eXqMi.js";
import { a as resolveGatewayAuth } from "./auth-BcIsRQqi.js";
import { a as inspectPortUsage, c as classifyPortListener, l as formatPortDiagnostics } from "./ports-CAJdnzGD.js";
import { f as loadGatewayTlsRuntime, n as callGateway } from "./call-BP56BqJF.js";
import { r as isWSLEnv } from "./wsl-BisEqrSr.js";
import { t as formatDocsLink } from "./links-_OmPhBsv.js";
import { n as withProgress } from "./progress-_rXhKU7V.js";
import { g as resolveControlUiLinks, h as randomToken } from "./onboard-helpers-C3I-0jon.js";
import { f as resolveGatewaySystemdServiceName, l as resolveGatewayLaunchAgentLabel } from "./constants-DHS1Cz8G.js";
import { n as inheritOptionFromParent } from "./command-options-Duxj7LwL.js";
import { t as buildGatewayInstallPlan } from "./daemon-install-helpers-BbXZcxdV.js";
import { r as isGatewayDaemonRuntime, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-uqrdhRz3.js";
import { s as resolveGatewayLogPaths, t as resolveGatewayService } from "./service-gv1-6Hix.js";
import { a as createCliStatusTextStyles, c as parsePortFromArgs, d as renderRuntimeHints, f as resolveRuntimeStatusColor, g as installDaemonServiceAndEmit, h as createDaemonActionContext, i as runServiceUninstall, l as pickProbeHostForBind, m as buildDaemonServiceSnapshot, n as runServiceStart, o as filterDaemonEnv, p as safeDaemonEnv, r as runServiceStop, s as normalizeListenerAddress, t as runServiceRestart, u as renderGatewayServiceStartHints } from "./lifecycle-core-DlnT_hDz.js";
import { i as auditGatewayServiceConfig, n as renderSystemdUnavailableHints, s as formatRuntimeStatus, t as isSystemdUnavailableDetail } from "./systemd-hints-CXkyZncY.js";
import { t as parsePort } from "./parse-port-Can_EDst.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-DUBCPq9h.js";
import { n as renderGatewayServiceCleanupHints, t as findExtraGatewayServices } from "./inspect-CMuKYy6i.js";

//#region src/cli/daemon-cli/install.ts
async function runDaemonInstall(opts) {
	const json = Boolean(opts.json);
	const { stdout, warnings, emit, fail } = createDaemonActionContext({
		action: "install",
		json
	});
	if (resolveIsNixMode(process.env)) {
		fail("Nix mode detected; service install is disabled.");
		return;
	}
	const cfg = loadConfig();
	const portOverride = parsePort(opts.port);
	if (opts.port !== void 0 && portOverride === null) {
		fail("Invalid port");
		return;
	}
	const port = portOverride ?? resolveGatewayPort(cfg);
	if (!Number.isFinite(port) || port <= 0) {
		fail("Invalid port");
		return;
	}
	const runtimeRaw = opts.runtime ? String(opts.runtime) : DEFAULT_GATEWAY_DAEMON_RUNTIME;
	if (!isGatewayDaemonRuntime(runtimeRaw)) {
		fail("Invalid --runtime (use \"node\" or \"bun\")");
		return;
	}
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (err) {
		fail(`Gateway service check failed: ${String(err)}`);
		return;
	}
	if (loaded) {
		if (!opts.force) {
			emit({
				ok: true,
				result: "already-installed",
				message: `Gateway service already ${service.loadedText}.`,
				service: buildDaemonServiceSnapshot(service, loaded)
			});
			if (!json) {
				defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
				defaultRuntime.log(`Reinstall with: ${formatCliCommand("openclaw gateway install --force")}`);
			}
			return;
		}
	}
	const resolvedAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off"
	});
	const needsToken = resolvedAuth.mode === "token" && !resolvedAuth.token && !resolvedAuth.allowTailscale;
	let token = opts.token || cfg.gateway?.auth?.token || process.env.OPENCLAW_GATEWAY_TOKEN || process.env.CLAWDBOT_GATEWAY_TOKEN;
	if (!token && needsToken) {
		token = randomToken();
		const warnMsg = "No gateway token found. Auto-generated one and saving to config.";
		if (json) warnings.push(warnMsg);
		else defaultRuntime.log(warnMsg);
		try {
			const snapshot = await readConfigFileSnapshot();
			if (snapshot.exists && !snapshot.valid) {
				const msg = "Warning: config file exists but is invalid; skipping token persistence.";
				if (json) warnings.push(msg);
				else defaultRuntime.log(msg);
			} else {
				const baseConfig = snapshot.exists ? snapshot.config : {};
				if (!baseConfig.gateway?.auth?.token) await writeConfigFile({
					...baseConfig,
					gateway: {
						...baseConfig.gateway,
						auth: {
							...baseConfig.gateway?.auth,
							mode: baseConfig.gateway?.auth?.mode ?? "token",
							token
						}
					}
				});
				else token = baseConfig.gateway.auth.token;
			}
		} catch (err) {
			const msg = `Warning: could not persist token to config: ${String(err)}`;
			if (json) warnings.push(msg);
			else defaultRuntime.log(msg);
		}
	}
	const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
		env: process.env,
		port,
		token,
		runtime: runtimeRaw,
		warn: (message) => {
			if (json) warnings.push(message);
			else defaultRuntime.log(message);
		},
		config: cfg
	});
	await installDaemonServiceAndEmit({
		serviceNoun: "Gateway",
		service,
		warnings,
		emit,
		fail,
		install: async () => {
			await service.install({
				env: process.env,
				stdout,
				programArguments,
				workingDirectory,
				environment
			});
		}
	});
}

//#endregion
//#region src/cli/daemon-cli/restart-health.ts
const DEFAULT_RESTART_HEALTH_TIMEOUT_MS = 6e4;
const DEFAULT_RESTART_HEALTH_DELAY_MS = 500;
const DEFAULT_RESTART_HEALTH_ATTEMPTS = Math.ceil(DEFAULT_RESTART_HEALTH_TIMEOUT_MS / DEFAULT_RESTART_HEALTH_DELAY_MS);
function listenerOwnedByRuntimePid(params) {
	return params.listener.pid === params.runtimePid || params.listener.ppid === params.runtimePid;
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
	const gatewayListeners = portUsage.status === "busy" ? portUsage.listeners.filter((listener) => classifyPortListener(listener, params.port) === "gateway") : [];
	const running = runtime.status === "running";
	const runtimePid = runtime.pid;
	const ownsPort = runtimePid != null ? portUsage.listeners.some((listener) => listenerOwnedByRuntimePid({
		listener,
		runtimePid
	})) : gatewayListeners.length > 0 || portUsage.status === "busy" && portUsage.listeners.length === 0;
	const healthy = running && ownsPort;
	const staleGatewayPids = Array.from(new Set(gatewayListeners.filter((listener) => Number.isFinite(listener.pid)).filter((listener) => {
		if (!running) return true;
		if (runtimePid == null) return true;
		return !listenerOwnedByRuntimePid({
			listener,
			runtimePid
		});
	}).map((listener) => listener.pid)));
	return {
		runtime,
		portUsage,
		healthy,
		staleGatewayPids
	};
}
async function waitForGatewayHealthyRestart(params) {
	const attempts = params.attempts ?? DEFAULT_RESTART_HEALTH_ATTEMPTS;
	const delayMs = params.delayMs ?? DEFAULT_RESTART_HEALTH_DELAY_MS;
	let snapshot = await inspectGatewayRestart({
		service: params.service,
		port: params.port,
		env: params.env
	});
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		if (snapshot.healthy) return snapshot;
		if (snapshot.staleGatewayPids.length > 0 && snapshot.runtime.status !== "running") return snapshot;
		await sleep(delayMs);
		snapshot = await inspectGatewayRestart({
			service: params.service,
			port: params.port,
			env: params.env
		});
	}
	return snapshot;
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
	if (snapshot.portUsage.status === "busy") lines.push(...formatPortDiagnostics(snapshot.portUsage));
	else lines.push(`Gateway port ${snapshot.portUsage.port} status: ${snapshot.portUsage.status}.`);
	if (snapshot.portUsage.errors?.length) lines.push(`Port diagnostics errors: ${snapshot.portUsage.errors.join("; ")}`);
	return lines;
}
async function terminateStaleGatewayPids(pids) {
	const killed = [];
	for (const pid of pids) try {
		process.kill(pid, "SIGTERM");
		killed.push(pid);
	} catch (err) {
		if (err?.code !== "ESRCH") throw err;
	}
	if (killed.length === 0) return killed;
	await sleep(400);
	for (const pid of killed) try {
		process.kill(pid, 0);
		process.kill(pid, "SIGKILL");
	} catch (err) {
		if (err?.code !== "ESRCH") throw err;
	}
	return killed;
}

//#endregion
//#region src/cli/daemon-cli/lifecycle.ts
const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = DEFAULT_RESTART_HEALTH_DELAY_MS;
async function resolveGatewayRestartPort() {
	const command = await resolveGatewayService().readCommand(process.env).catch(() => null);
	const serviceEnv = command?.environment ?? void 0;
	const mergedEnv = {
		...process.env,
		...serviceEnv ?? void 0
	};
	return parsePortFromArgs(command?.programArguments) ?? resolveGatewayPort(loadConfig(), mergedEnv);
}
async function runDaemonUninstall(opts = {}) {
	return await runServiceUninstall({
		serviceNoun: "Gateway",
		service: resolveGatewayService(),
		opts,
		stopBeforeUninstall: true,
		assertNotLoadedAfterUninstall: true
	});
}
async function runDaemonStart(opts = {}) {
	return await runServiceStart({
		serviceNoun: "Gateway",
		service: resolveGatewayService(),
		renderStartHints: renderGatewayServiceStartHints,
		opts
	});
}
async function runDaemonStop(opts = {}) {
	return await runServiceStop({
		serviceNoun: "Gateway",
		service: resolveGatewayService(),
		opts
	});
}
/**
* Restart the gateway service service.
* @returns `true` if restart succeeded, `false` if the service was not loaded.
* Throws/exits on check or restart failures.
*/
async function runDaemonRestart(opts = {}) {
	const json = Boolean(opts.json);
	const service = resolveGatewayService();
	const restartPort = await resolveGatewayRestartPort().catch(() => resolveGatewayPort(loadConfig(), process.env));
	const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
	const restartWaitSeconds = Math.round(restartWaitMs / 1e3);
	return await runServiceRestart({
		serviceNoun: "Gateway",
		service,
		renderStartHints: renderGatewayServiceStartHints,
		opts,
		checkTokenDrift: true,
		postRestartCheck: async ({ warnings, fail, stdout }) => {
			let health = await waitForGatewayHealthyRestart({
				service,
				port: restartPort,
				attempts: POST_RESTART_HEALTH_ATTEMPTS,
				delayMs: POST_RESTART_HEALTH_DELAY_MS
			});
			if (!health.healthy && health.staleGatewayPids.length > 0) {
				const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
				warnings.push(staleMsg);
				if (!json) {
					defaultRuntime.log(theme.warn(staleMsg));
					defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
				}
				await terminateStaleGatewayPids(health.staleGatewayPids);
				await service.restart({
					env: process.env,
					stdout
				});
				health = await waitForGatewayHealthyRestart({
					service,
					port: restartPort,
					attempts: POST_RESTART_HEALTH_ATTEMPTS,
					delayMs: POST_RESTART_HEALTH_DELAY_MS
				});
			}
			if (health.healthy) return;
			const diagnostics = renderRestartDiagnostics(health);
			const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
			const runningNoPortLine = health.runtime.status === "running" && health.portUsage.status === "free" ? `Gateway process is running but port ${restartPort} is still free (startup hang/crash loop or very slow VM startup).` : null;
			if (!json) {
				defaultRuntime.log(theme.warn(timeoutLine));
				if (runningNoPortLine) defaultRuntime.log(theme.warn(runningNoPortLine));
				for (const line of diagnostics) defaultRuntime.log(theme.muted(line));
			} else {
				warnings.push(timeoutLine);
				if (runningNoPortLine) warnings.push(runningNoPortLine);
				warnings.push(...diagnostics);
			}
			fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")]);
		}
	});
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
async function gatherDaemonStatus(opts) {
	const service = resolveGatewayService();
	const [loaded, command, runtime] = await Promise.all([
		service.isLoaded({ env: process.env }).catch(() => false),
		service.readCommand(process.env).catch(() => null),
		service.readRuntime(process.env).catch((err) => ({
			status: "unknown",
			detail: String(err)
		}))
	]);
	const configAudit = await auditGatewayServiceConfig({
		env: process.env,
		command
	});
	const serviceEnv = command?.environment ?? void 0;
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
	const configMismatch = cliConfigSummary.path !== daemonConfigSummary.path;
	const portFromArgs = parsePortFromArgs(command?.programArguments);
	const daemonPort = portFromArgs ?? resolveGatewayPort(daemonCfg, mergedDaemonEnv);
	const portSource = portFromArgs ? "service args" : "env/config";
	const bindMode = daemonCfg.gateway?.bind ?? "loopback";
	const customBindHost = daemonCfg.gateway?.customBindHost;
	const bindHost = await resolveGatewayBindHost(bindMode, customBindHost);
	const probeHost = pickProbeHostForBind(bindMode, pickPrimaryTailnetIPv4(), customBindHost);
	const probeUrlOverride = typeof opts.rpc.url === "string" && opts.rpc.url.trim().length > 0 ? opts.rpc.url.trim() : null;
	const scheme = daemonCfg.gateway?.tls?.enabled === true ? "wss" : "ws";
	const probeUrl = probeUrlOverride ?? `${scheme}://${probeHost}:${daemonPort}`;
	const probeNote = !probeUrlOverride && bindMode === "lan" ? `bind=lan listens on 0.0.0.0 (all interfaces); probing via ${probeHost}.` : !probeUrlOverride && bindMode === "loopback" ? "Loopback-only gateway; only local clients can connect." : void 0;
	const cliPort = resolveGatewayPort(cliCfg, process.env);
	const [portDiagnostics, portCliDiagnostics] = await Promise.all([inspectPortUsage(daemonPort).catch(() => null), cliPort !== daemonPort ? inspectPortUsage(cliPort).catch(() => null) : null]);
	const portStatus = portDiagnostics ? {
		port: portDiagnostics.port,
		status: portDiagnostics.status,
		listeners: portDiagnostics.listeners,
		hints: portDiagnostics.hints
	} : void 0;
	const portCliStatus = portCliDiagnostics ? {
		port: portCliDiagnostics.port,
		status: portCliDiagnostics.status,
		listeners: portCliDiagnostics.listeners,
		hints: portCliDiagnostics.hints
	} : void 0;
	const extraServices = await findExtraGatewayServices(process.env, { deep: Boolean(opts.deep) }).catch(() => []);
	const timeoutMsRaw = Number.parseInt(String(opts.rpc.timeout ?? "10000"), 10);
	const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 1e4;
	const tlsEnabled = daemonCfg.gateway?.tls?.enabled === true;
	const shouldUseLocalTlsRuntime = opts.probe && !probeUrlOverride && tlsEnabled;
	const tlsRuntime = shouldUseLocalTlsRuntime ? await loadGatewayTlsRuntime(daemonCfg.gateway?.tls) : void 0;
	const rpc = opts.probe ? await probeGatewayStatus({
		url: probeUrl,
		token: opts.rpc.token || mergedDaemonEnv.OPENCLAW_GATEWAY_TOKEN || daemonCfg.gateway?.auth?.token,
		password: opts.rpc.password || mergedDaemonEnv.OPENCLAW_GATEWAY_PASSWORD || daemonCfg.gateway?.auth?.password,
		tlsFingerprint: shouldUseLocalTlsRuntime && tlsRuntime?.enabled ? tlsRuntime.fingerprintSha256 : void 0,
		timeoutMs,
		json: opts.rpc.json,
		configPath: daemonConfigSummary.path
	}) : void 0;
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
		gateway: {
			bindMode,
			bindHost,
			customBindHost,
			port: daemonPort,
			portSource,
			probeUrl,
			...probeNote ? { probeNote } : {}
		},
		port: portStatus,
		...portCliStatus ? { portCli: portCliStatus } : {},
		lastError,
		...rpc ? { rpc: {
			...rpc,
			url: probeUrl
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
		if (!status.config.cli.valid && status.config.cli.issues?.length) for (const issue of status.config.cli.issues.slice(0, 5)) defaultRuntime.error(`${errorText("Config issue:")} ${issue.path || "<root>"}: ${issue.message}`);
		if (status.config.daemon) {
			const daemonCfg = `${shortenHomePath(status.config.daemon.path)}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
			defaultRuntime.log(`${label("Config (service):")} ${infoText(daemonCfg)}`);
			if (!status.config.daemon.valid && status.config.daemon.issues?.length) for (const issue of status.config.daemon.issues.slice(0, 5)) defaultRuntime.error(`${errorText("Service config issue:")} ${issue.path || "<root>"}: ${issue.message}`);
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
			if (rpc.url) defaultRuntime.error(`${label("RPC target:")} ${rpc.url}`);
			const lines = String(rpc.error ?? "unknown").split(/\r?\n/).filter(Boolean);
			for (const line of lines.slice(0, 12)) defaultRuntime.error(`  ${errorText(line)}`);
		}
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
async function runDaemonStatus(opts) {
	try {
		printDaemonStatus(await gatherDaemonStatus({
			rpc: opts.rpc,
			probe: Boolean(opts.probe),
			deep: Boolean(opts.deep)
		}), { json: Boolean(opts.json) });
	} catch (err) {
		const rich = isRich();
		defaultRuntime.error(colorize(rich, theme.error, `Gateway status failed: ${String(err)}`));
		defaultRuntime.exit(1);
	}
}

//#endregion
//#region src/cli/daemon-cli/register-service-commands.ts
function resolveInstallOptions(cmdOpts, command) {
	const parentForce = inheritOptionFromParent(command, "force");
	const parentPort = inheritOptionFromParent(command, "port");
	const parentToken = inheritOptionFromParent(command, "token");
	return {
		...cmdOpts,
		force: Boolean(cmdOpts.force || parentForce),
		port: cmdOpts.port ?? parentPort,
		token: cmdOpts.token ?? parentToken
	};
}
function resolveRpcOptions(cmdOpts, command) {
	const parentToken = inheritOptionFromParent(command, "token");
	const parentPassword = inheritOptionFromParent(command, "password");
	return {
		...cmdOpts,
		token: cmdOpts.token ?? parentToken,
		password: cmdOpts.password ?? parentPassword
	};
}
function addGatewayServiceCommands(parent, opts) {
	parent.command("status").description(opts?.statusDescription ?? "Show gateway service status + probe the Gateway").option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (password auth)").option("--timeout <ms>", "Timeout in ms", "10000").option("--no-probe", "Skip RPC probe").option("--deep", "Scan system-level services", false).option("--json", "Output JSON", false).action(async (cmdOpts, command) => {
		await runDaemonStatus({
			rpc: resolveRpcOptions(cmdOpts, command),
			probe: Boolean(cmdOpts.probe),
			deep: Boolean(cmdOpts.deep),
			json: Boolean(cmdOpts.json)
		});
	});
	parent.command("install").description("Install the Gateway service (launchd/systemd/schtasks)").option("--port <port>", "Gateway port").option("--runtime <runtime>", "Daemon runtime (node|bun). Default: node").option("--token <token>", "Gateway token (token auth)").option("--force", "Reinstall/overwrite if already installed", false).option("--json", "Output JSON", false).action(async (cmdOpts, command) => {
		await runDaemonInstall(resolveInstallOptions(cmdOpts, command));
	});
	parent.command("uninstall").description("Uninstall the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonUninstall(cmdOpts);
	});
	parent.command("start").description("Start the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonStart(cmdOpts);
	});
	parent.command("stop").description("Stop the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonStop(cmdOpts);
	});
	parent.command("restart").description("Restart the Gateway service (launchd/systemd/schtasks)").option("--json", "Output JSON", false).action(async (cmdOpts) => {
		await runDaemonRestart(cmdOpts);
	});
}

//#endregion
//#region src/cli/daemon-cli/register.ts
function registerDaemonCli(program) {
	addGatewayServiceCommands(program.command("daemon").description("Manage the Gateway service (launchd/systemd/schtasks)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`), { statusDescription: "Show service install status + probe the Gateway" });
}

//#endregion
//#region src/cli/daemon-cli.ts
var daemon_cli_exports = /* @__PURE__ */ __exportAll({ registerDaemonCli: () => registerDaemonCli });

//#endregion
export { terminateStaleGatewayPids as a, renderRestartDiagnostics as i, addGatewayServiceCommands as n, waitForGatewayHealthyRestart as o, runDaemonRestart as r, runDaemonInstall as s, daemon_cli_exports as t };