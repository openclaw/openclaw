import { d as resolveGatewayPort } from "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme } from "./theme-CL08MjAq.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { n as inheritOptionFromParent } from "./command-options-CwQM9XPT.js";
import { Hb as readBestEffortConfig } from "./auth-profiles-DAOR1fRn.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { r as isRestartEnabled } from "./commands-BfMCtxuV.js";
import { n as buildGatewayInstallPlan, t as resolveGatewayInstallToken } from "./gateway-install-token-TIg1tNFo.js";
import { r as isGatewayDaemonRuntime, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-Tgt-ZRti.js";
import { a as formatGatewayPidList, i as findVerifiedGatewayListenerPidsOnPortSync, n as resolveGatewayService, o as signalVerifiedGatewayPidSync } from "./service-BRvD766e.js";
import { n as isNonFatalSystemdInstallProbeError } from "./systemd-Ca2xqSN-.js";
import { c as renderGatewayServiceStartHints, f as buildDaemonServiceSnapshot, h as installDaemonServiceAndEmit, n as createDaemonInstallActionContext, o as parsePortFromArgs, r as failIfNixDaemonInstallMode } from "./shared-CCPEqzJi.js";
import { t as parsePort } from "./parse-port-CfABYuqb.js";
import { t as probeGateway } from "./probe-XzGfgPsl.js";
import { i as runServiceUninstall, n as runServiceStart, r as runServiceStop, t as runServiceRestart } from "./lifecycle-core-_e-4cOok.js";
import { a as terminateStaleGatewayPids, i as renderRestartDiagnostics, n as DEFAULT_RESTART_HEALTH_ATTEMPTS, o as waitForGatewayHealthyListener, r as renderGatewayPortHealthDiagnostics, s as waitForGatewayHealthyRestart, t as runDaemonStatus } from "./status-CsbXYOcT.js";
//#region src/cli/daemon-cli/install.ts
init_runtime();
async function runDaemonInstall(opts) {
	const { json, stdout, warnings, emit, fail } = createDaemonInstallActionContext(opts.json);
	if (failIfNixDaemonInstallMode(fail)) return;
	const cfg = await readBestEffortConfig();
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
		if (isNonFatalSystemdInstallProbeError(err)) loaded = false;
		else {
			fail(`Gateway service check failed: ${String(err)}`);
			return;
		}
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
	const tokenResolution = await resolveGatewayInstallToken({
		config: cfg,
		env: process.env,
		explicitToken: opts.token,
		autoGenerateWhenMissing: true,
		persistGeneratedToken: true
	});
	if (tokenResolution.unavailableReason) {
		fail(`Gateway install blocked: ${tokenResolution.unavailableReason}`);
		return;
	}
	for (const warning of tokenResolution.warnings) if (json) warnings.push(warning);
	else defaultRuntime.log(warning);
	const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
		env: process.env,
		port,
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
//#region src/cli/daemon-cli/lifecycle.ts
init_runtime();
init_theme();
const POST_RESTART_HEALTH_ATTEMPTS = DEFAULT_RESTART_HEALTH_ATTEMPTS;
const POST_RESTART_HEALTH_DELAY_MS = 500;
async function resolveGatewayLifecyclePort(service = resolveGatewayService()) {
	const command = await service.readCommand(process.env).catch(() => null);
	const serviceEnv = command?.environment ?? void 0;
	const mergedEnv = {
		...process.env,
		...serviceEnv ?? void 0
	};
	return parsePortFromArgs(command?.programArguments) ?? resolveGatewayPort(await readBestEffortConfig(), mergedEnv);
}
function resolveGatewayPortFallback() {
	return readBestEffortConfig().then((cfg) => resolveGatewayPort(cfg, process.env)).catch(() => resolveGatewayPort(void 0, process.env));
}
async function assertUnmanagedGatewayRestartEnabled(port) {
	const probe = await probeGateway({
		url: `${!!(await readBestEffortConfig().catch(() => void 0))?.gateway?.tls?.enabled ? "wss" : "ws"}://127.0.0.1:${port}`,
		auth: {
			token: process.env.OPENCLAW_GATEWAY_TOKEN?.trim() || void 0,
			password: process.env.OPENCLAW_GATEWAY_PASSWORD?.trim() || void 0
		},
		timeoutMs: 1e3
	}).catch(() => null);
	if (!probe?.ok) return;
	if (!isRestartEnabled(probe.configSnapshot)) throw new Error("Gateway restart is disabled in the running gateway config (commands.restart=false); unmanaged SIGUSR1 restart would be ignored");
}
function resolveVerifiedGatewayListenerPids(port) {
	return findVerifiedGatewayListenerPidsOnPortSync(port).filter((pid) => Number.isFinite(pid) && pid > 0);
}
async function stopGatewayWithoutServiceManager(port) {
	const pids = resolveVerifiedGatewayListenerPids(port);
	if (pids.length === 0) return null;
	for (const pid of pids) signalVerifiedGatewayPidSync(pid, "SIGTERM");
	return {
		result: "stopped",
		message: `Gateway stop signal sent to unmanaged process${pids.length === 1 ? "" : "es"} on port ${port}: ${formatGatewayPidList(pids)}.`
	};
}
async function restartGatewayWithoutServiceManager(port) {
	await assertUnmanagedGatewayRestartEnabled(port);
	const pids = resolveVerifiedGatewayListenerPids(port);
	if (pids.length === 0) return null;
	if (pids.length > 1) throw new Error(`multiple gateway processes are listening on port ${port}: ${formatGatewayPidList(pids)}; use "openclaw gateway status --deep" before retrying restart`);
	signalVerifiedGatewayPidSync(pids[0], "SIGUSR1");
	return {
		result: "restarted",
		message: `Gateway restart signal sent to unmanaged process on port ${port}: ${pids[0]}.`
	};
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
	const service = resolveGatewayService();
	const gatewayPort = await resolveGatewayLifecyclePort(service).catch(() => resolveGatewayPortFallback());
	return await runServiceStop({
		serviceNoun: "Gateway",
		service,
		opts,
		onNotLoaded: async () => stopGatewayWithoutServiceManager(gatewayPort)
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
	let restartedWithoutServiceManager = false;
	const restartPort = await resolveGatewayLifecyclePort(service).catch(() => resolveGatewayPortFallback());
	const restartWaitMs = POST_RESTART_HEALTH_ATTEMPTS * POST_RESTART_HEALTH_DELAY_MS;
	const restartWaitSeconds = Math.round(restartWaitMs / 1e3);
	return await runServiceRestart({
		serviceNoun: "Gateway",
		service,
		renderStartHints: renderGatewayServiceStartHints,
		opts,
		checkTokenDrift: true,
		onNotLoaded: async () => {
			const handled = await restartGatewayWithoutServiceManager(restartPort);
			if (handled) restartedWithoutServiceManager = true;
			return handled;
		},
		postRestartCheck: async ({ warnings, fail, stdout }) => {
			if (restartedWithoutServiceManager) {
				const health = await waitForGatewayHealthyListener({
					port: restartPort,
					attempts: POST_RESTART_HEALTH_ATTEMPTS,
					delayMs: POST_RESTART_HEALTH_DELAY_MS
				});
				if (health.healthy) return;
				const diagnostics = renderGatewayPortHealthDiagnostics(health);
				const timeoutLine = `Timed out after ${restartWaitSeconds}s waiting for gateway port ${restartPort} to become healthy.`;
				if (!json) {
					defaultRuntime.log(theme.warn(timeoutLine));
					for (const line of diagnostics) defaultRuntime.log(theme.muted(line));
				} else {
					warnings.push(timeoutLine);
					warnings.push(...diagnostics);
				}
				fail(`Gateway restart timed out after ${restartWaitSeconds}s waiting for health checks.`, [formatCliCommand("openclaw gateway status --deep"), formatCliCommand("openclaw doctor")]);
			}
			let health = await waitForGatewayHealthyRestart({
				service,
				port: restartPort,
				attempts: POST_RESTART_HEALTH_ATTEMPTS,
				delayMs: POST_RESTART_HEALTH_DELAY_MS,
				includeUnknownListenersAsStale: process.platform === "win32"
			});
			if (!health.healthy && health.staleGatewayPids.length > 0) {
				const staleMsg = `Found stale gateway process(es): ${health.staleGatewayPids.join(", ")}.`;
				warnings.push(staleMsg);
				if (!json) {
					defaultRuntime.log(theme.warn(staleMsg));
					defaultRuntime.log(theme.muted("Stopping stale process(es) and retrying restart..."));
				}
				await terminateStaleGatewayPids(health.staleGatewayPids);
				const retryRestart = await service.restart({
					env: process.env,
					stdout
				});
				if (retryRestart.outcome === "scheduled") return retryRestart;
				health = await waitForGatewayHealthyRestart({
					service,
					port: restartPort,
					attempts: POST_RESTART_HEALTH_ATTEMPTS,
					delayMs: POST_RESTART_HEALTH_DELAY_MS,
					includeUnknownListenersAsStale: process.platform === "win32"
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
	parent.command("status").description(opts?.statusDescription ?? "Show gateway service status + probe the Gateway").option("--url <url>", "Gateway WebSocket URL (defaults to config/remote/local)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (password auth)").option("--timeout <ms>", "Timeout in ms", "10000").option("--no-probe", "Skip RPC probe").option("--require-rpc", "Exit non-zero when the RPC probe fails", false).option("--deep", "Scan system-level services", false).option("--json", "Output JSON", false).action(async (cmdOpts, command) => {
		await runDaemonStatus({
			rpc: resolveRpcOptions(cmdOpts, command),
			probe: Boolean(cmdOpts.probe),
			requireRpc: Boolean(cmdOpts.requireRpc),
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
init_theme();
function registerDaemonCli(program) {
	addGatewayServiceCommands(program.command("daemon").description("Manage the Gateway service (launchd/systemd/schtasks)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`), { statusDescription: "Show service install status + probe the Gateway" });
}
//#endregion
export { runDaemonStop as a, runDaemonStart as i, addGatewayServiceCommands as n, runDaemonUninstall as o, runDaemonRestart as r, runDaemonInstall as s, registerDaemonCli as t };
