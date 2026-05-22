import { s as normalizeOptionalLowercaseString } from "../string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "../errors-B5idDZn1.js";
import { v as isContainerEnvironment } from "../net-DCUMtgJy.js";
import { i as getRuntimeConfig } from "../io-BxFubSMj.js";
import "../config-FC9eV8ec.js";
import { c as markGatewaySigusr1RestartHandled, d as resolveGatewayRestartDeferralTimeoutMs, f as scheduleGatewaySigusr1Restart, h as triggerOpenClawRestart, i as consumeGatewaySigusr1RestartAuthorization, l as peekGatewaySigusr1RestartReason, n as consumeGatewayRestartIntentPayloadSync, r as consumeGatewayRestartIntentSync, s as isGatewaySigusr1RestartExternallyAllowed, u as resetGatewayRestartStateForInProcessRestart } from "../restart-B6q6duKj.js";
import { r as writeGatewayRestartHandoffSync } from "../restart-handoff-Ccvpappf.js";
import { p as writeDiagnosticStabilityBundleForFailureSync } from "../diagnostic-stability-bundle-CvLuJy9w.js";
import { c as listActiveEmbeddedRunSessionKeys, o as getActiveEmbeddedRunCount, s as listActiveEmbeddedRunSessionIds } from "../run-state-BqdKyAME.js";
import { g as waitForActiveEmbeddedRuns, n as abortEmbeddedPiRun } from "../runs-CkOGrSum.js";
import { a as getActiveTaskCount, d as markGatewayDraining, f as resetAllLanes, h as waitForActiveTasks } from "../command-queue-Cc__1ixy.js";
import { a as markUpdateRestartSentinelFailure } from "../restart-sentinel-CYKBibC4.js";
import { C as reloadTaskRegistryFromStore } from "../task-registry-B7WTToIp.js";
import "../runtime-internal-MjFqCVxG.js";
import { t as markRestartAbortedMainSessions } from "../main-session-restart-recovery-DGCQwjqr.js";
import { n as detectRespawnSupervisor } from "../supervisor-markers-B5EgETF5.js";
import { n as getInspectableActiveTaskRestartBlockers } from "../task-registry.maintenance-B_y-oBEJ.js";
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
