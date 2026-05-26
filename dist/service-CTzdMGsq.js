import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { d as stopSystemdService, l as restartSystemdService, o as readSystemdServiceExecStart, p as uninstallSystemdService, r as isSystemdServiceEnabled, s as readSystemdServiceRuntime, t as installSystemdService, u as stageSystemdService } from "./systemd-DsQkjgIm.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { n as formatFutureConfigActionBlock, r as resolveFutureConfigActionBlock } from "./future-version-guard-B-IQpuuA.js";
import { _ as stageLaunchAgent, d as readLaunchAgentProgramArguments, f as readLaunchAgentRuntime, g as restartLaunchAgent, i as installLaunchAgent, o as isLaunchAgentLoaded, v as stopLaunchAgent, y as uninstallLaunchAgent } from "./launchd-CTjF-v1R.js";
import "./config-B6Oplu5W.js";
import { c as stopScheduledTask, i as readScheduledTaskRuntime, l as uninstallScheduledTask, n as isScheduledTaskInstalled, o as restartScheduledTask, r as readScheduledTaskCommand, s as stageScheduledTask, t as installScheduledTask } from "./schtasks-DgedhOde.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
//#region src/daemon/future-config-guard.ts
async function readFutureConfigActionBlock(action) {
	try {
		return resolveFutureConfigActionBlock({
			action,
			snapshot: await readConfigFileSnapshot()
		});
	} catch {
		return null;
	}
}
async function assertFutureConfigActionAllowed(action) {
	const block = await readFutureConfigActionBlock(action);
	if (block) throw new Error(formatFutureConfigActionBlock(block));
}
//#endregion
//#region src/daemon/service.ts
function ignoreServiceWriteResult(write) {
	return async (args) => {
		await write(args);
	};
}
function mergeGatewayServiceEnv(baseEnv, command) {
	if (!command?.environment) return baseEnv;
	return {
		...baseEnv,
		...command.environment
	};
}
const TEMP_PROGRAM_ROOTS = [
	os.tmpdir(),
	"/tmp",
	"/private/tmp",
	"/var/tmp"
].map((entry) => path.resolve(entry));
function pathIsSameOrChild(candidate, parent) {
	return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}
function isTemporaryProgramPath(value) {
	if (!value || !path.isAbsolute(value)) return false;
	const resolved = path.resolve(value);
	return TEMP_PROGRAM_ROOTS.some((root) => pathIsSameOrChild(resolved, root));
}
function isMissingProgramPath(value) {
	if (!value || !path.isAbsolute(value)) return false;
	return !fs.existsSync(value);
}
function collectGatewayServiceStartRepairIssues(state) {
	const command = state.command;
	if (!state.loaded || !command) return [];
	const issues = [];
	const serviceVersion = command.environment?.OPENCLAW_SERVICE_VERSION?.trim();
	if (serviceVersion && serviceVersion !== VERSION) issues.push({
		code: "version-mismatch",
		message: `service was installed by OpenClaw ${serviceVersion}, current CLI is ${VERSION}`
	});
	for (const candidate of command.programArguments.slice(0, 2)) {
		if (isTemporaryProgramPath(candidate)) {
			issues.push({
				code: "temporary-program",
				message: `service command points at a temporary path: ${candidate}`
			});
			continue;
		}
		if (isMissingProgramPath(candidate)) issues.push({
			code: "missing-program",
			message: `service command points at a missing path: ${candidate}`
		});
	}
	return issues;
}
function formatGatewayServiceStartRepairIssues(issues) {
	return issues.map((issue) => issue.message).join("; ");
}
async function readGatewayServiceState(service, args = {}) {
	const baseEnv = args.env ?? process.env;
	const command = await service.readCommand(baseEnv).catch(() => null);
	const env = mergeGatewayServiceEnv(baseEnv, command);
	const [loaded, runtime] = await Promise.all([service.isLoaded({ env }).catch(() => false), service.readRuntime(env).catch(() => void 0)]);
	return {
		installed: command !== null,
		loaded,
		running: runtime?.status === "running",
		env,
		command,
		runtime
	};
}
async function startGatewayService(service, args) {
	const state = await readGatewayServiceState(service, { env: args.env });
	if (!state.loaded && !state.installed) return {
		outcome: "missing-install",
		state
	};
	const repairIssues = collectGatewayServiceStartRepairIssues(state);
	if (repairIssues.length > 0) return {
		outcome: "repair-required",
		state,
		issues: repairIssues
	};
	try {
		const restartResult = await service.restart({
			...args,
			env: state.env
		});
		const nextState = await readGatewayServiceState(service, { env: state.env });
		return {
			outcome: restartResult.outcome === "scheduled" ? "scheduled" : "started",
			state: nextState
		};
	} catch (err) {
		const nextState = await readGatewayServiceState(service, { env: state.env });
		if (!nextState.installed) return {
			outcome: "missing-install",
			state: nextState
		};
		throw err;
	}
}
function describeGatewayServiceRestart(serviceNoun, result) {
	if (result.outcome === "scheduled") return {
		scheduled: true,
		daemonActionResult: "scheduled",
		message: `restart scheduled, ${normalizeLowercaseStringOrEmpty(serviceNoun)} will restart momentarily`,
		progressMessage: `${serviceNoun} service restart scheduled.`
	};
	return {
		scheduled: false,
		daemonActionResult: "restarted",
		message: `${serviceNoun} service restarted.`,
		progressMessage: `${serviceNoun} service restarted.`
	};
}
const GATEWAY_SERVICE_REGISTRY = {
	darwin: {
		label: "LaunchAgent",
		loadedText: "loaded",
		notLoadedText: "not loaded",
		stage: ignoreServiceWriteResult(stageLaunchAgent),
		install: ignoreServiceWriteResult(installLaunchAgent),
		uninstall: uninstallLaunchAgent,
		stop: stopLaunchAgent,
		restart: restartLaunchAgent,
		isLoaded: isLaunchAgentLoaded,
		readCommand: readLaunchAgentProgramArguments,
		readRuntime: readLaunchAgentRuntime
	},
	linux: {
		label: "systemd user",
		loadedText: "enabled",
		notLoadedText: "disabled",
		stage: ignoreServiceWriteResult(stageSystemdService),
		install: ignoreServiceWriteResult(installSystemdService),
		uninstall: uninstallSystemdService,
		stop: stopSystemdService,
		restart: restartSystemdService,
		isLoaded: isSystemdServiceEnabled,
		readCommand: readSystemdServiceExecStart,
		readRuntime: readSystemdServiceRuntime
	},
	win32: {
		label: "Scheduled Task",
		loadedText: "registered",
		notLoadedText: "missing",
		stage: ignoreServiceWriteResult(stageScheduledTask),
		install: ignoreServiceWriteResult(installScheduledTask),
		uninstall: uninstallScheduledTask,
		stop: stopScheduledTask,
		restart: restartScheduledTask,
		isLoaded: isScheduledTaskInstalled,
		readCommand: readScheduledTaskCommand,
		readRuntime: readScheduledTaskRuntime
	}
};
function withFutureConfigGuard(service) {
	return {
		...service,
		stage: async (args) => {
			await assertFutureConfigActionAllowed("rewrite the gateway service");
			return await service.stage(args);
		},
		install: async (args) => {
			await assertFutureConfigActionAllowed("install or rewrite the gateway service");
			return await service.install(args);
		},
		uninstall: async (args) => {
			await assertFutureConfigActionAllowed("uninstall the gateway service");
			return await service.uninstall(args);
		},
		stop: async (args) => {
			await assertFutureConfigActionAllowed("stop the gateway service");
			return await service.stop(args);
		},
		restart: async (args) => {
			await assertFutureConfigActionAllowed("restart the gateway service");
			return await service.restart(args);
		}
	};
}
function isSupportedGatewayServicePlatform(platform) {
	return Object.hasOwn(GATEWAY_SERVICE_REGISTRY, platform);
}
function resolveGatewayService() {
	if (isSupportedGatewayServicePlatform(process.platform)) return withFutureConfigGuard(GATEWAY_SERVICE_REGISTRY[process.platform]);
	throw new Error(`Gateway service install not supported on ${process.platform}`);
}
//#endregion
export { startGatewayService as a, resolveGatewayService as i, formatGatewayServiceStartRepairIssues as n, readGatewayServiceState as r, describeGatewayServiceRestart as t };
