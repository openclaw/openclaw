import { s as normalizeOptionalLowercaseString } from "../string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "../errors-b3ZrCRlt.js";
import { v as isContainerEnvironment } from "../net-DCUMtgJy.js";
import { i as getRuntimeConfig } from "../io-DoswVvYe.js";
import "../config-B6Oplu5W.js";
import { c as markGatewaySigusr1RestartHandled, d as resolveGatewayRestartDeferralTimeoutMs, f as scheduleGatewaySigusr1Restart, h as triggerOpenClawRestart, i as consumeGatewaySigusr1RestartAuthorization, l as peekGatewaySigusr1RestartReason, n as consumeGatewayRestartIntentPayloadSync, r as consumeGatewayRestartIntentSync, s as isGatewaySigusr1RestartExternallyAllowed, u as resetGatewayRestartStateForInProcessRestart } from "../restart-C-r_0sSG.js";
import { r as writeGatewayRestartHandoffSync } from "../restart-handoff-BSak1pJo.js";
import { C as reloadTaskRegistryFromStore } from "../task-registry-B9ljq8Nk.js";
import "../runtime-internal-2F71tA3B.js";
import { p as writeDiagnosticStabilityBundleForFailureSync } from "../diagnostic-stability-bundle-fLJOD4qU.js";
import { c as listActiveEmbeddedRunSessionKeys, o as getActiveEmbeddedRunCount, s as listActiveEmbeddedRunSessionIds } from "../run-state-primn49x.js";
import { g as waitForActiveEmbeddedRuns, n as abortEmbeddedPiRun } from "../runs-DrbsiywK.js";
import { t as markRestartAbortedMainSessions } from "../main-session-restart-recovery-C_yReR9o.js";
import { n as detectRespawnSupervisor } from "../supervisor-markers-B5EgETF5.js";
import { a as markUpdateRestartSentinelFailure } from "../restart-sentinel-BDtpdKoy.js";
import { a as getActiveTaskCount, d as markGatewayDraining, f as resetAllLanes, h as waitForActiveTasks } from "../command-queue-Da2Lh3Ua.js";
import { n as getInspectableActiveTaskRestartBlockers } from "../task-registry.maintenance-BGxQNDMF.js";
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
* - unmanaged environments: caller should keep in-process restart behavior so
*   custom supervisors keep tracking the same gateway PID
*/
function restartGatewayProcessWithFreshPid(_opts = {}) {
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
	return {
		mode: "disabled",
		detail: "unmanaged: use in-process restart to keep custom supervisor PID tracking stable"
	};
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
