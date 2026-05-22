import { s as normalizeOptionalLowercaseString } from "../string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "../errors-D0hgXIu9.js";
import { t as isContainerEnvironment } from "../container-environment-Bk7eZ65v.js";
import { i as getRuntimeConfig } from "../io-q2yb7vWQ.js";
import "../config-CW5G5Uky.js";
import { c as markGatewaySigusr1RestartHandled, d as resolveGatewayRestartDeferralTimeoutMs, f as scheduleGatewaySigusr1Restart, h as triggerOpenClawRestart, i as consumeGatewaySigusr1RestartAuthorization, l as peekGatewaySigusr1RestartReason, n as consumeGatewayRestartIntentPayloadSync, r as consumeGatewayRestartIntentSync, s as isGatewaySigusr1RestartExternallyAllowed, u as resetGatewayRestartStateForInProcessRestart } from "../restart-DgmKlEgH.js";
import { r as writeGatewayRestartHandoffSync } from "../restart-handoff-DqjH-nN8.js";
import { o as getActiveEmbeddedRunCount } from "../run-state-DiEMnEv0.js";
import { f as writeDiagnosticStabilityBundleForFailureSync } from "../diagnostic-stability-bundle-BLdO6vvX.js";
import { m as waitForActiveEmbeddedRuns, n as abortEmbeddedPiRun } from "../runs-B1mS1E6k.js";
import { a as getActiveTaskCount, d as resetAllLanes, m as waitForActiveTasks, u as markGatewayDraining } from "../command-queue-CP0QCgD4.js";
import { a as markUpdateRestartSentinelFailure } from "../restart-sentinel-B7N5vTz7.js";
import { S as reloadTaskRegistryFromStore } from "../task-registry-ketv1Mq9.js";
import "../runtime-internal-CkxVx1Kf.js";
import { t as detectRespawnSupervisor } from "../supervisor-markers-DjPlU9k7.js";
import { n as getInspectableActiveTaskRestartBlockers } from "../task-registry.maintenance-B2oBiLDp.js";
import { spawn } from "node:child_process";
//#region src/infra/process-respawn.ts
function isTruthy(value) {
	const normalized = normalizeOptionalLowercaseString(value);
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
function spawnDetachedGatewayProcess() {
	const args = [...process.execArgv, ...process.argv.slice(1)];
	const child = spawn(process.execPath, args, {
		env: process.env,
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
function restartGatewayProcessWithFreshPid() {
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
		const { pid } = spawnDetachedGatewayProcess();
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
function respawnGatewayProcessForUpdate() {
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
		const { child, pid } = spawnDetachedGatewayProcess();
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
export { abortEmbeddedPiRun, consumeGatewayRestartIntentPayloadSync, consumeGatewayRestartIntentSync, consumeGatewaySigusr1RestartAuthorization, detectRespawnSupervisor, getActiveEmbeddedRunCount, getActiveTaskCount, getInspectableActiveTaskRestartBlockers, getRuntimeConfig, isGatewaySigusr1RestartExternallyAllowed, markGatewayDraining, markGatewaySigusr1RestartHandled, markUpdateRestartSentinelFailure, peekGatewaySigusr1RestartReason, reloadTaskRegistryFromStore, resetAllLanes, resetGatewayRestartStateForInProcessRestart, resolveGatewayRestartDeferralTimeoutMs, respawnGatewayProcessForUpdate, restartGatewayProcessWithFreshPid, scheduleGatewaySigusr1Restart, waitForActiveEmbeddedRuns, waitForActiveTasks, writeDiagnosticStabilityBundleForFailureSync, writeGatewayRestartHandoffSync };
