import { d as resolveGatewayPort } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { _ as sleep } from "./utils-sBTEdeml.js";
import { g as resolveNodeLaunchAgentLabel, m as resolveGatewayWindowsTaskName, p as resolveGatewaySystemdServiceName, u as resolveGatewayLaunchAgentLabel } from "./constants-CmvvKVqh.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint } from "./auth-install-policy-BV9KSYis.js";
import { a as isSystemdUserServiceAvailable, m as classifySystemdUnavailableDetail } from "./systemd-DsQkjgIm.js";
import { n as GATEWAY_DAEMON_RUNTIME_OPTIONS, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-C5rLdYLT.js";
import { a as getResolvedLoggerSettings } from "./logger-Dg9dVaLI.js";
import { t as resolveGatewayInstallToken } from "./gateway-install-token-D0PJZIzI.js";
import { a as inspectPortConnections, d as isExpectedGatewayListeners, l as formatPortDiagnostics, o as inspectPortUsage } from "./ports-C3z_VZTO.js";
import { c as launchAgentPlistExists, m as repairLaunchAgentBootstrap, o as isLaunchAgentLoaded } from "./launchd-CTjF-v1R.js";
import "./config-B6Oplu5W.js";
import { i as resolveGatewayService, t as describeGatewayServiceRestart } from "./service-CTzdMGsq.js";
import { a as isSystemdUnavailableDetail, i as resolveDaemonContainerContext, o as renderSystemdUnavailableHints, r as formatRuntimeStatus, t as buildPlatformRuntimeLogHints } from "./runtime-hints-BcO9gSNA.js";
import { r as isWSLEnv, t as isWSL } from "./wsl-2-jVkfxN.js";
import { t as readLastGatewayErrorLine } from "./diagnostics-p6c0nawT.js";
import { n as readGatewayRestartHandoffSync, t as formatGatewayRestartHandoffDiagnostic } from "./restart-handoff-BSak1pJo.js";
import { r as findSystemGatewayServices } from "./inspect-z8z06zzv.js";
import "./logging-B2Kt4cNB.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { n as formatHealthCheckFailure } from "./health-format-DaSqSjzQ.js";
import { n as healthCommand } from "./health-MpLQnEZv.js";
import { a as resolveServiceRepairPolicy, i as isServiceRepairExternallyManaged, n as SERVICE_REPAIR_POLICY_ENV, r as confirmDoctorServiceRepair, t as EXTERNAL_SERVICE_REPAIR_NOTE } from "./doctor-service-repair-policy-LxeeO6r9.js";
//#region src/commands/doctor-format.ts
function formatGatewayRuntimeSummary(runtime) {
	return formatRuntimeStatus(runtime);
}
function buildGatewayRuntimeHints(runtime, options = {}) {
	const hints = [];
	if (!runtime) return hints;
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const container = Boolean(resolveDaemonContainerContext(env));
	const fileLog = (() => {
		try {
			return getResolvedLoggerSettings().file;
		} catch {
			return null;
		}
	})();
	if (platform === "linux" && isSystemdUnavailableDetail(runtime.detail)) {
		hints.push(...renderSystemdUnavailableHints({
			wsl: isWSLEnv(),
			kind: classifySystemdUnavailableDetail(runtime.detail),
			container
		}));
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.cachedLabel && platform === "darwin") {
		const label = resolveGatewayLaunchAgentLabel(env.OPENCLAW_PROFILE);
		hints.push(`LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${label}`);
		hints.push(`Then reinstall: ${formatCliCommand("openclaw gateway install", env)}`);
	}
	if (runtime.missingUnit) {
		hints.push(`Service not installed. Run: ${formatCliCommand("openclaw gateway install", env)}`);
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.missingSupervision && platform === "darwin") {
		hints.push(`LaunchAgent installed but not loaded. Run: ${formatCliCommand("openclaw gateway restart", env)}`);
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		return hints;
	}
	if (runtime.status === "stopped") {
		hints.push("Service is loaded but not running (likely exited immediately).");
		if (fileLog) hints.push(`File logs: ${fileLog}`);
		hints.push(...buildPlatformRuntimeLogHints({
			platform,
			env,
			systemdServiceName: resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE),
			windowsTaskName: resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE)
		}));
	}
	return hints;
}
//#endregion
//#region src/commands/doctor-gateway-daemon-flow.ts
async function maybeRepairLaunchAgentBootstrap(params) {
	if (process.platform !== "darwin") return false;
	if (!await launchAgentPlistExists(params.env)) return false;
	if (await isLaunchAgentLoaded({ env: params.env })) return false;
	note("LaunchAgent is installed but not loaded in launchd.", `${params.title} LaunchAgent`);
	if (params.serviceRepairExternal) {
		note(EXTERNAL_SERVICE_REPAIR_NOTE, `${params.title} LaunchAgent`);
		return false;
	}
	if (!await confirmDoctorServiceRepair(params.prompter, {
		message: `Repair ${params.title} LaunchAgent bootstrap now?`,
		initialValue: true
	})) return false;
	params.runtime.log(`Bootstrapping ${params.title} LaunchAgent...`);
	const repair = await repairLaunchAgentBootstrap({ env: params.env });
	if (!repair.ok) {
		params.runtime.error(`${params.title} LaunchAgent bootstrap failed: ${repair.detail ?? "unknown error"}`);
		return false;
	}
	if (!await isLaunchAgentLoaded({ env: params.env })) {
		params.runtime.error(`${params.title} LaunchAgent still not loaded after repair.`);
		return false;
	}
	note(`${params.title} LaunchAgent repaired.`, `${params.title} LaunchAgent`);
	return true;
}
function renderBlockingSystemGatewayServices(services) {
	return [
		"System-level OpenClaw gateway service detected while the user gateway service is not installed.",
		...services.map((svc) => `- ${svc.label} (${svc.detail})`),
		"OpenClaw will not install a second user-level gateway service automatically.",
		"Run `openclaw gateway status --deep` or `openclaw doctor --deep` to inspect duplicate services.",
		`Set ${SERVICE_REPAIR_POLICY_ENV}=external if a system supervisor owns the gateway lifecycle.`
	].join("\n");
}
function renderEstablishedGatewayConnections(connections) {
	return [
		"Established Gateway TCP clients detected:",
		...connections.slice(0, 8).map((connection) => {
			return `- ${connection.pid ? `pid=${connection.pid}` : "pid=?"} ${connection.direction}${connection.command ? ` ${connection.command}` : ""}${connection.address ? ` ${connection.address}` : ""}${connection.commandLine ? ` cmd=${connection.commandLine}` : ""}`;
		}),
		...connections.length > 8 ? [`- ... ${connections.length - 8} more connection(s)`] : [],
		"If logs show protocol mismatch after rollback, stop stale OpenClaw client processes listed here and rerun doctor."
	].join("\n");
}
async function maybeReportEstablishedGatewayClients(params) {
	if (!params.deep || params.cfg.gateway?.mode === "remote") return;
	const establishedClients = (await inspectPortConnections(params.port ?? resolveGatewayPort(params.cfg, process.env)).catch(() => null))?.connections.filter((connection) => connection.direction !== "server");
	if (establishedClients && establishedClients.length > 0) note(renderEstablishedGatewayConnections(establishedClients), "Gateway clients");
}
async function maybeRepairGatewayDaemon(params) {
	if (params.healthOk) {
		await maybeReportEstablishedGatewayClients({
			cfg: params.cfg,
			deep: params.options.deep ?? false
		});
		return;
	}
	const serviceRepairPolicy = resolveServiceRepairPolicy();
	const serviceRepairExternal = isServiceRepairExternallyManaged(serviceRepairPolicy);
	const service = resolveGatewayService();
	let loaded = false;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	let serviceRuntime;
	const command = params.options.deep ? await Promise.resolve(service.readCommand(process.env)).catch(() => null) : null;
	const serviceEnv = command?.environment ? {
		...process.env,
		...command.environment
	} : process.env;
	if (loaded) serviceRuntime = await service.readRuntime(serviceEnv).catch(() => void 0);
	if (params.options.deep) {
		const handoff = readGatewayRestartHandoffSync(serviceEnv);
		if (handoff) note(formatGatewayRestartHandoffDiagnostic(handoff), "Gateway");
	}
	if (process.platform === "darwin" && params.cfg.gateway?.mode !== "remote") {
		const gatewayRepaired = await maybeRepairLaunchAgentBootstrap({
			env: process.env,
			title: "Gateway",
			runtime: params.runtime,
			prompter: params.prompter,
			serviceRepairExternal
		});
		await maybeRepairLaunchAgentBootstrap({
			env: {
				...process.env,
				OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel()
			},
			title: "Node",
			runtime: params.runtime,
			prompter: params.prompter,
			serviceRepairExternal
		});
		if (gatewayRepaired) {
			loaded = await service.isLoaded({ env: process.env });
			if (loaded) serviceRuntime = await service.readRuntime(process.env).catch(() => void 0);
		}
	}
	if (params.cfg.gateway?.mode !== "remote") {
		const port = resolveGatewayPort(params.cfg, process.env);
		const diagnostics = await inspectPortUsage(port);
		await maybeReportEstablishedGatewayClients({
			cfg: params.cfg,
			deep: params.options.deep ?? false,
			port
		});
		if (diagnostics.status === "busy" && !isExpectedGatewayListeners(diagnostics.listeners, diagnostics.port)) note(formatPortDiagnostics(diagnostics).join("\n"), "Gateway port");
		else if (loaded && serviceRuntime?.status === "running") {
			const lastError = await readLastGatewayErrorLine(process.env);
			if (lastError) note(`Last gateway error: ${lastError}`, "Gateway");
		}
	}
	if (!loaded) {
		if (process.platform === "linux") {
			if (!await isSystemdUserServiceAvailable().catch(() => false)) {
				note(renderSystemdUnavailableHints({
					wsl: await isWSL(),
					kind: "generic_unavailable"
				}).join("\n"), "Gateway");
				return;
			}
		}
		note("Gateway service not installed.", "Gateway");
		if (params.cfg.gateway?.mode !== "remote") {
			if (process.platform === "linux") {
				const systemGatewayServices = await findSystemGatewayServices();
				if (systemGatewayServices.length > 0) {
					note(renderBlockingSystemGatewayServices(systemGatewayServices), "Gateway");
					return;
				}
			}
			if (serviceRepairExternal) {
				note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
				return;
			}
			const install = await confirmDoctorServiceRepair(params.prompter, {
				message: "Install gateway service now?",
				initialValue: true,
				requiresInteractiveConfirmation: true
			}, serviceRepairPolicy);
			if (!install) note(`Run ${formatCliCommand("openclaw gateway install")} when you want to install the gateway service.`, "Gateway");
			if (install) {
				const daemonRuntime = await params.prompter.select({
					message: "Gateway service runtime",
					options: GATEWAY_DAEMON_RUNTIME_OPTIONS,
					initialValue: DEFAULT_GATEWAY_DAEMON_RUNTIME
				}, DEFAULT_GATEWAY_DAEMON_RUNTIME);
				const tokenResolution = await resolveGatewayInstallToken({
					config: params.cfg,
					env: process.env
				});
				for (const warning of tokenResolution.warnings) note(warning, "Gateway");
				if (tokenResolution.unavailableReason) {
					note([
						"Gateway service install aborted.",
						tokenResolution.unavailableReason,
						"Fix gateway auth config/token input and rerun doctor."
					].join("\n"), "Gateway");
					return;
				}
				const port = resolveGatewayPort(params.cfg, process.env);
				const { programArguments, workingDirectory, environment, environmentValueSources } = await buildGatewayInstallPlan({
					env: process.env,
					port,
					runtime: daemonRuntime,
					warn: (message, title) => note(message, title),
					config: params.cfg
				});
				try {
					await service.install({
						env: process.env,
						stdout: process.stdout,
						programArguments,
						workingDirectory,
						environment,
						environmentValueSources
					});
				} catch (err) {
					note(`Gateway service install failed: ${String(err)}`, "Gateway");
					note(gatewayInstallErrorHint(), "Gateway");
				}
			}
		}
		return;
	}
	const summary = formatGatewayRuntimeSummary(serviceRuntime);
	const hints = buildGatewayRuntimeHints(serviceRuntime, {
		platform: process.platform,
		env: process.env
	});
	if (summary || hints.length > 0) {
		const lines = [];
		if (summary) lines.push(`Runtime: ${summary}`);
		lines.push(...hints);
		note(lines.join("\n"), "Gateway");
	}
	if (serviceRuntime?.status !== "running") {
		if (serviceRepairExternal) {
			note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
			return;
		}
		if (await confirmDoctorServiceRepair(params.prompter, {
			message: "Start gateway service now?",
			initialValue: true
		}, serviceRepairPolicy)) {
			const restartStatus = describeGatewayServiceRestart("Gateway", await service.restart({
				env: process.env,
				stdout: process.stdout
			}));
			if (!restartStatus.scheduled) await sleep(1500);
			else note(restartStatus.message, "Gateway");
		}
	}
	if (process.platform === "darwin") {
		const label = resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);
		note(`LaunchAgent loaded; stopping requires "${formatCliCommand("openclaw gateway stop")}" or launchctl bootout gui/$UID/${label}.`, "Gateway");
	}
	if (serviceRuntime?.status === "running") {
		if (serviceRepairExternal) {
			note(EXTERNAL_SERVICE_REPAIR_NOTE, "Gateway");
			return;
		}
		if (await confirmDoctorServiceRepair(params.prompter, {
			message: "Restart gateway service now?",
			initialValue: true
		}, serviceRepairPolicy)) {
			const restartStatus = describeGatewayServiceRestart("Gateway", await service.restart({
				env: process.env,
				stdout: process.stdout
			}));
			if (restartStatus.scheduled) {
				note(restartStatus.message, "Gateway");
				return;
			}
			await sleep(1500);
			try {
				await healthCommand({
					json: false,
					timeoutMs: 1e4
				}, params.runtime);
			} catch (err) {
				if (String(err).includes("gateway closed")) {
					note("Gateway not running.", "Gateway");
					note(params.gatewayDetailsMessage, "Gateway connection");
				} else params.runtime.error(formatHealthCheckFailure(err));
			}
		}
	}
}
//#endregion
export { maybeRepairGatewayDaemon };
