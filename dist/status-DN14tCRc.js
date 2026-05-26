import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { n as isRich, r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { g as shortenHomePath } from "./utils-sBTEdeml.js";
import { p as resolveGatewaySystemdServiceName, u as resolveGatewayLaunchAgentLabel } from "./constants-CmvvKVqh.js";
import { m as classifySystemdUnavailableDetail } from "./systemd-DsQkjgIm.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as formatConfigIssueLine } from "./issue-format-c8ezaSew.js";
import { a as resolveGatewaySupervisorLogPaths, i as resolveGatewayRestartLogPath } from "./restart-logs-DA9VPiFu.js";
import { a as isSystemdUnavailableDetail, i as resolveDaemonContainerContext, o as renderSystemdUnavailableHints, r as formatRuntimeStatus } from "./runtime-hints-BcO9gSNA.js";
import { r as isWSLEnv } from "./wsl-2-jVkfxN.js";
import { a as filterDaemonEnv, d as resolveRuntimeStatusColor, f as safeDaemonEnv, t as createCliStatusTextStyles, u as renderRuntimeHints } from "./shared-X3VACeu2.js";
import { t as formatGatewayRestartHandoffDiagnostic } from "./restart-handoff-BSak1pJo.js";
import { n as renderPortDiagnosticsForCli, r as resolvePortListeningAddresses, t as gatherDaemonStatus } from "./status.gather-Dondx7P0.js";
import { i as renderGatewayServiceCleanupHints } from "./inspect-z8z06zzv.js";
import { t as resolveControlUiLinks } from "./control-ui-links-BSo6xNaU.js";
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
function formatProbeKindLabel(kind) {
	return kind === "read" ? "Read probe:" : "Connectivity probe:";
}
function formatCapabilityLabel(capability) {
	if (!capability) return null;
	return capability.replaceAll("_", "-");
}
function formatCliVersionLine(cli) {
	if (!cli) return null;
	return cli.entrypoint ? `${cli.version} (${shortenHomePath(cli.entrypoint)})` : cli.version;
}
function formatConnectionLine(connection) {
	return `${connection.pid ? `pid=${connection.pid}` : "pid=?"}${connection.ppid ? ` ppid=${connection.ppid}` : ""}${` ${connection.direction}`}${connection.command ? ` ${connection.command}` : ""}${connection.address ? ` ${connection.address}` : ""}${connection.commandLine ? ` cmd=${shortenHomePath(connection.commandLine)}` : ""}`;
}
function printDaemonStatus(status, opts) {
	if (opts.json) {
		const sanitized = sanitizeDaemonStatusForJson(status);
		defaultRuntime.writeJson(sanitized);
		return;
	}
	const { rich, label, accent, infoText, okText, warnText, errorText } = createCliStatusTextStyles();
	const spacer = () => defaultRuntime.log("");
	const { service, rpc, extraServices } = status;
	const serviceStatus = service.loaded ? okText(service.loadedText) : warnText(service.notLoadedText);
	defaultRuntime.log(`${label("Service:")} ${accent(service.label)} (${serviceStatus})`);
	if (status.logFile) defaultRuntime.log(`${label("File logs:")} ${infoText(shortenHomePath(status.logFile))}`);
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
		if (status.config.cli.warnings?.length) {
			defaultRuntime.error(warnText("Config warnings:"));
			for (const warning of status.config.cli.warnings.slice(0, 5)) defaultRuntime.error(warnText(formatConfigIssueLine(warning, "-", { normalizeRoot: true })));
		}
		if (status.config.daemon) {
			const daemonCfg = `${shortenHomePath(status.config.daemon.path)}${status.config.daemon.exists ? "" : " (missing)"}${status.config.daemon.valid ? "" : " (invalid)"}`;
			defaultRuntime.log(`${label("Config (service):")} ${infoText(daemonCfg)}`);
			if (!status.config.daemon.valid && status.config.daemon.issues?.length) for (const issue of status.config.daemon.issues.slice(0, 5)) defaultRuntime.error(`${errorText("Service config issue:")} ${formatConfigIssueLine(issue, "", { normalizeRoot: true })}`);
			if (status.config.daemon !== status.config.cli && status.config.daemon.warnings?.length) {
				const warningsLabel = status.config.daemon.path === status.config.cli.path ? "Config warnings:" : "Service config warnings:";
				defaultRuntime.error(warnText(warningsLabel));
				for (const warning of status.config.daemon.warnings.slice(0, 5)) defaultRuntime.error(warnText(formatConfigIssueLine(warning, "-", { normalizeRoot: true })));
			}
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
				basePath: status.config?.daemon?.controlUi?.basePath,
				tlsEnabled: status.gateway.tlsEnabled === true
			});
			defaultRuntime.log(`${label("Dashboard:")} ${infoText(links.httpUrl)}`);
		}
		if (status.gateway.probeNote) defaultRuntime.log(`${label("Probe note:")} ${infoText(status.gateway.probeNote)}`);
		spacer();
	}
	const gatewayVersion = rpc?.server?.version?.trim() || status.gateway?.version?.trim();
	const cliVersionLine = formatCliVersionLine(status.cli);
	if (gatewayVersion) {
		if (cliVersionLine) defaultRuntime.log(`${label("CLI version:")} ${infoText(cliVersionLine)}`);
		defaultRuntime.log(`${label("Gateway version:")} ${infoText(gatewayVersion)}`);
		if (status.cli?.version && status.cli.version !== gatewayVersion) {
			defaultRuntime.error(warnText(`Warning: this OpenClaw command is version ${status.cli.version}, but the running Gateway is version ${gatewayVersion}.`));
			defaultRuntime.error(warnText("Check `openclaw --version`, `which openclaw`, and `openclaw gateway status --deep`; if this mismatch is unexpected, update PATH so `openclaw` points to the version you want, or reinstall the Gateway service from that same OpenClaw install."));
		}
		spacer();
	}
	const runtimeLine = formatRuntimeStatus(service.runtime);
	if (runtimeLine) {
		const runtimeColor = resolveRuntimeStatusColor(service.runtime?.status);
		defaultRuntime.log(`${label("Runtime:")} ${colorize(rich, runtimeColor, runtimeLine)}`);
	}
	if (service.restartHandoff) defaultRuntime.log(infoText(formatGatewayRestartHandoffDiagnostic(service.restartHandoff)));
	if (rpc && !rpc.ok && service.loaded && service.runtime?.status === "running") defaultRuntime.log(warnText("Warm-up: launch agents can take a few seconds. Try again shortly."));
	if (rpc) {
		const probeLabel = formatProbeKindLabel(rpc.kind);
		if (rpc.ok) defaultRuntime.log(`${label(probeLabel)} ${okText("ok")}`);
		else {
			defaultRuntime.error(`${label(probeLabel)} ${errorText("failed")}`);
			if (rpc.authWarning) defaultRuntime.error(`${label("Probe auth:")} ${warnText(rpc.authWarning)}`);
			if (rpc.url) defaultRuntime.error(`${label("Probe target:")} ${rpc.url}`);
			const lines = (rpc.error ?? "unknown").split(/\r?\n/).filter(Boolean);
			for (const line of lines.slice(0, 12)) defaultRuntime.error(`  ${errorText(line)}`);
		}
		const capability = formatCapabilityLabel(rpc.capability);
		if (capability) defaultRuntime.log(`${label("Capability:")} ${infoText(capability)}`);
		spacer();
	}
	if (status.health && status.health.staleGatewayPids.length > 0 && service.runtime?.status === "running" && typeof service.runtime.pid === "number") {
		defaultRuntime.error(errorText(`Gateway runtime PID does not own the listening port. Other gateway process(es) are listening: ${status.health.staleGatewayPids.join(", ")}`));
		defaultRuntime.error(errorText(`Fix: run ${formatCliCommand("openclaw gateway restart")} and re-check with ${formatCliCommand("openclaw gateway status --deep")}.`));
		spacer();
	}
	if (status.connections?.established.length) {
		defaultRuntime.log(`${label("Established clients:")} ${infoText(String(status.connections.established.length))}`);
		for (const connection of status.connections.established.slice(0, 8)) defaultRuntime.log(`  ${infoText(formatConnectionLine(connection))}`);
		if (status.connections.established.length > 8) defaultRuntime.log(`  ${infoText(`... ${status.connections.established.length - 8} more connection(s)`)}`);
		defaultRuntime.log(warnText("If logs show protocol mismatch after rollback, stop stale OpenClaw client processes listed here and re-run gateway status."));
		spacer();
	}
	if (process.platform === "linux" && rpc?.ok !== true && isSystemdUnavailableDetail(service.runtime?.detail)) {
		const container = Boolean(resolveDaemonContainerContext(service.command?.environment ?? process.env));
		defaultRuntime.error(errorText("systemd user services unavailable."));
		for (const hint of renderSystemdUnavailableHints({
			wsl: isWSLEnv(),
			kind: classifySystemdUnavailableDetail(service.runtime?.detail),
			container
		})) defaultRuntime.error(errorText(hint));
		spacer();
	}
	if (service.runtime?.missingUnit) {
		defaultRuntime.error(errorText("Service unit not found."));
		for (const hint of renderRuntimeHints(service.runtime, process.env, status.logFile)) defaultRuntime.error(errorText(hint));
	} else if (service.runtime?.missingSupervision) {
		defaultRuntime.error(errorText("LaunchAgent plist exists but launchd has no loaded job."));
		for (const hint of renderRuntimeHints(service.runtime, service.command?.environment ?? process.env, status.logFile)) defaultRuntime.error(errorText(hint));
	} else if (service.loaded && service.runtime?.status === "stopped") {
		defaultRuntime.error(errorText("Service is loaded but not running (likely exited immediately)."));
		for (const hint of renderRuntimeHints(service.runtime, service.command?.environment ?? process.env, status.logFile)) defaultRuntime.error(errorText(hint));
		spacer();
	}
	if (service.runtime?.cachedLabel) {
		const labelValue = resolveGatewayLaunchAgentLabel((service.command?.environment ?? process.env).OPENCLAW_PROFILE);
		defaultRuntime.error(errorText(`LaunchAgent label cached but plist missing. Clear with: launchctl bootout gui/$UID/${labelValue}`));
		defaultRuntime.error(errorText(`Then reinstall: ${formatCliCommand("openclaw gateway install")}`));
		spacer();
	}
	if (service.staleUpdateLaunchdJobs?.length) {
		defaultRuntime.error(errorText("Stale OpenClaw updater launchd job(s) detected."));
		for (const job of service.staleUpdateLaunchdJobs) {
			const exitStatus = job.lastExitStatus !== void 0 ? `, last exit ${job.lastExitStatus}` : "";
			const pid = job.pid !== void 0 ? `, pid ${job.pid}` : "";
			defaultRuntime.error(errorText(`- ${job.label}${pid}${exitStatus}`));
		}
		defaultRuntime.error(errorText(`Fix after confirming no update is running: launchctl remove <label>, then run ${formatCliCommand("openclaw gateway restart")}.`));
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
		const serviceEnv = {
			...process.env,
			...service.command?.environment
		};
		if (status.lastError) defaultRuntime.error(`${errorText("Last gateway error:")} ${status.lastError}`);
		if (process.platform === "linux") {
			const unit = resolveGatewaySystemdServiceName(serviceEnv.OPENCLAW_PROFILE);
			defaultRuntime.error(errorText(`Logs: journalctl --user -u ${unit}.service -n 200 --no-pager`));
		} else if (process.platform === "darwin") {
			const logs = resolveGatewaySupervisorLogPaths(serviceEnv, { platform: "darwin" });
			defaultRuntime.error(`${errorText("Logs:")} ${shortenHomePath(logs.stdoutPath)}`);
			defaultRuntime.error(`${errorText("Errors:")} suppressed`);
		}
		defaultRuntime.error(`${errorText("Restart log:")} ${shortenHomePath(resolveGatewayRestartLogPath(serviceEnv))}`);
		spacer();
	}
	if (extraServices.length > 0) {
		defaultRuntime.log(warnText("Other gateway-like services detected (best effort):"));
		for (const svc of extraServices) defaultRuntime.log(`- ${warnText(svc.label)} (${svc.scope}, ${svc.detail})`);
		for (const hint of renderGatewayServiceCleanupHints()) defaultRuntime.log(`${infoText("Cleanup hint:")} ${hint}`);
		spacer();
	}
	if (extraServices.length > 0) {
		defaultRuntime.log(infoText("Recommendation: run a single gateway per machine for most setups. One gateway supports multiple agents (see docs: /gateway#multiple-gateways-same-host)."));
		defaultRuntime.log(infoText("If you need multiple gateways (e.g., a rescue bot on the same host), isolate ports + config/state (see docs: /gateway#multiple-gateways-same-host)."));
		spacer();
	}
	defaultRuntime.log(`${label("Troubles:")} run ${formatCliCommand("openclaw status")}`);
	defaultRuntime.log(`${label("Troubleshooting:")} https://docs.openclaw.ai/troubleshooting`);
}
//#endregion
//#region src/cli/daemon-cli/status.ts
async function runDaemonStatus(opts) {
	try {
		if (opts.requireRpc && !opts.probe) {
			defaultRuntime.error("Gateway status failed: --require-rpc needs probing enabled. Remove --no-probe or drop --require-rpc.");
			defaultRuntime.exit(1);
			return;
		}
		const status = await gatherDaemonStatus({
			rpc: opts.rpc,
			probe: opts.probe,
			requireRpc: opts.requireRpc,
			deep: opts.deep === true
		});
		printDaemonStatus(status, { json: opts.json });
		if (opts.requireRpc && !status.rpc?.ok) defaultRuntime.exit(1);
	} catch (err) {
		const rich = isRich();
		defaultRuntime.error(colorize(rich, theme.error, `Gateway status failed: ${String(err)}`));
		defaultRuntime.exit(1);
	}
}
//#endregion
export { runDaemonStatus as t };
