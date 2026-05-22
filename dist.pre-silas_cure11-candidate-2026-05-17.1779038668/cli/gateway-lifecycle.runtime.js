import { s as normalizeOptionalLowercaseString } from "../string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "../errors-ixwfrboQ.js";
import { v as isContainerEnvironment } from "../net-DW8WQG5I.js";
import { i as getRuntimeConfig } from "../io-DxdqJz8n.js";
import "../config-CddmOexD.js";
import { c as markGatewaySigusr1RestartHandled, d as resolveGatewayRestartDeferralTimeoutMs, f as scheduleGatewaySigusr1Restart, h as triggerOpenClawRestart, i as consumeGatewaySigusr1RestartAuthorization, l as peekGatewaySigusr1RestartReason, n as consumeGatewayRestartIntentPayloadSync, r as consumeGatewayRestartIntentSync, s as isGatewaySigusr1RestartExternallyAllowed, u as resetGatewayRestartStateForInProcessRestart } from "../restart-DD_XDFb-.js";
import { r as writeGatewayRestartHandoffSync } from "../restart-handoff-CXBbTTBI.js";
import { p as writeDiagnosticStabilityBundleForFailureSync } from "../diagnostic-stability-bundle-DEIlcBO3.js";
import { c as listActiveEmbeddedRunSessionKeys, o as getActiveEmbeddedRunCount, s as listActiveEmbeddedRunSessionIds } from "../run-state-CjCLucsk.js";
import { g as waitForActiveEmbeddedRuns, n as abortEmbeddedPiRun } from "../runs-DJy1UN9B.js";
import { a as getActiveTaskCount, d as markGatewayDraining, f as resetAllLanes, h as waitForActiveTasks } from "../command-queue-B_ee8LAq.js";
import { a as markUpdateRestartSentinelFailure } from "../restart-sentinel-BO0EVNis.js";
import { S as reloadTaskRegistryFromStore } from "../task-registry-yiD-WWdH.js";
import "../runtime-internal-CCQ_VPFT.js";
import { t as markRestartAbortedMainSessions } from "../main-session-restart-recovery-CX9i5RJB.js";
import { n as detectRespawnSupervisor } from "../supervisor-markers-Clsofc9T.js";
import { n as getInspectableActiveTaskRestartBlockers } from "../task-registry.maintenance-B0bKu7KZ.js";
import { spawn } from "node:child_process";
//#region src/infra/process-respawn.ts
function isTruthy(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function spawnDetachedGatewayProcess(opts = {}) {
	const args = [...process.execArgv, ...process.argv.slice(1)];
	const child = spawn(process.execPath, args, {
		env: opts.env ? {
			...process.env,
			...opts.env
		} : process.env,
		detached: true,
		stdio: "inherit"
	});
	child.unref();
	return {
		child,
		pid: child.pid ?? void 0
	};
}
/**
* Attempt to restart this process with a fresh PID.
* - supervised environments (launchd/systemd/schtasks): caller should exit and let supervisor restart
* - OPENCLAW_NO_RESPAWN=1: caller should keep in-process restart behavior (tests/dev)
* - otherwise: spawn detached child with current argv/execArgv, then caller exits
*/
function restartGatewayProcessWithFreshPid(opts = {}) {
	if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) return { mode: "disabled" };
	const supervisor = detectRespawnSupervisor(process.env);
	if (supervisor) {
		if (supervisor === "schtasks") {
			const restart = triggerOpenClawRestart();
			if (!restart.ok) return {
				mode: "failed",
				detail: restart.detail ?? `${restart.method} restart failed`
			};
		}
		return { mode: "supervised" };
	}
	if (process.platform === "win32") return {
		mode: "disabled",
		detail: "win32: detached respawn unsupported without Scheduled Task markers"
	};
	if (isContainerEnvironment()) return {
		mode: "disabled",
		detail: "container: use in-process restart to keep PID 1 alive"
	};
	try {
		const { pid } = spawnDetachedGatewayProcess(opts);
		return {
			mode: "spawned",
			pid
		};
	} catch (err) {
		return {
			mode: "failed",
			detail: formatErrorMessage(err)
		};
	}
}
/**
* Update restarts must replace the OS process so the new code runs from a
* fresh module graph after package files have changed on disk.
*
* Unlike the generic restart path, update mode allows detached respawn on
* unmanaged Windows installs because there is no safe in-process fallback once
* the installed package contents have been replaced.
*/
function respawnGatewayProcessForUpdate(opts = {}) {
	if (isTruthy(process.env.OPENCLAW_NO_RESPAWN)) return {
		mode: "disabled",
		detail: "OPENCLAW_NO_RESPAWN"
	};
	const supervisor = detectRespawnSupervisor(process.env);
	if (supervisor) {
		if (supervisor === "schtasks") {
			const restart = triggerOpenClawRestart();
			if (!restart.ok) return {
				mode: "failed",
				detail: restart.detail ?? `${restart.method} restart failed`
			};
		}
		return { mode: "supervised" };
	}
	try {
		const { child, pid } = spawnDetachedGatewayProcess(opts);
		return {
			mode: "spawned",
			pid,
			child
		};
	} catch (err) {
		return {
			mode: "failed",
			detail: formatErrorMessage(err)
		};
	}
}
//#endregion
export { abortEmbeddedPiRun, consumeGatewayRestartIntentPayloadSync, consumeGatewayRestartIntentSync, consumeGatewaySigusr1RestartAuthorization, detectRespawnSupervisor, getActiveEmbeddedRunCount, getActiveTaskCount, getInspectableActiveTaskRestartBlockers, getRuntimeConfig, isGatewaySigusr1RestartExternallyAllowed, listActiveEmbeddedRunSessionIds, listActiveEmbeddedRunSessionKeys, markGatewayDraining, markGatewaySigusr1RestartHandled, markRestartAbortedMainSessions, markUpdateRestartSentinelFailure, peekGatewaySigusr1RestartReason, reloadTaskRegistryFromStore, resetAllLanes, resetGatewayRestartStateForInProcessRestart, resolveGatewayRestartDeferralTimeoutMs, respawnGatewayProcessForUpdate, restartGatewayProcessWithFreshPid, scheduleGatewaySigusr1Restart, waitForActiveEmbeddedRuns, waitForActiveTasks, writeDiagnosticStabilityBundleForFailureSync, writeGatewayRestartHandoffSync };
