import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { m as resolveGatewayWindowsTaskName, p as resolveGatewaySystemdServiceName, u as resolveGatewayLaunchAgentLabel } from "./constants-CmvvKVqh.js";
import { i as replaceFileAtomicSync } from "./replace-file-C7_Inj8B.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as quoteCmdScriptArg } from "./cmd-argv-fj4pRVR6.js";
import { t as cleanStaleGatewayProcessesSync } from "./restart-stale-pids-BubeCFq3.js";
import { t as renderCmdRestartLogSetup } from "./restart-logs-DA9VPiFu.js";
import "./config-B6Oplu5W.js";
import { a as resolveTaskScriptPath } from "./schtasks-DgedhOde.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
//#region src/infra/windows-task-restart.ts
const TASK_RESTART_RETRY_LIMIT = 12;
const TASK_RESTART_RETRY_DELAY_SEC = 1;
function quotePowerShellSingleQuotedLiteral(value) {
	return `'${value.replace(/'/g, "''")}'`;
}
function resolveWindowsTaskName(env) {
	const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
	if (override) return override;
	return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}
function buildScheduledTaskRestartScript(params) {
	const { quotedLogPath, setupLines, taskName, taskScriptPath } = params;
	const quotedTaskName = quoteCmdScriptArg(taskName);
	const quotedQueryTaskStateCommand = quoteCmdScriptArg(`(Get-ScheduledTask -TaskName ${quotePowerShellSingleQuotedLiteral(taskName)} -ErrorAction SilentlyContinue).State`);
	const lines = [
		"@echo off",
		"setlocal",
		...setupLines,
		`>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart attempt source=windows-task-handoff target=${quotedTaskName}`,
		`schtasks /Query /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
		"if errorlevel 1 goto fallback",
		"set /a attempts=0",
		":retry",
		`timeout /t ${TASK_RESTART_RETRY_DELAY_SEC} /nobreak >nul`,
		"set /a attempts+=1",
		`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${quotedQueryTaskStateCommand} 2>nul | findstr /I /C:"Running" >nul 2>&1`,
		"if not errorlevel 1 goto cleanup",
		`schtasks /Run /TN ${quotedTaskName} >> ${quotedLogPath} 2>&1`,
		"if not errorlevel 1 goto cleanup",
		`if %attempts% GEQ ${TASK_RESTART_RETRY_LIMIT} goto fallback`,
		"goto retry",
		":fallback",
		`>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart fallback source=windows-task-handoff`
	];
	if (taskScriptPath) {
		const quotedScript = quoteCmdScriptArg(taskScriptPath);
		lines.push(`if exist ${quotedScript} (`, `  start "" /min cmd.exe /d /c ${quotedScript}`, ")");
	}
	lines.push(":cleanup", `>> ${quotedLogPath} 2>&1 echo [%DATE% %TIME%] openclaw restart finished source=windows-task-handoff`, "del \"%~f0\" >nul 2>&1");
	return lines.join("\r\n");
}
function relaunchGatewayScheduledTask(env = process.env) {
	const taskName = resolveWindowsTaskName(env);
	const taskScriptPath = resolveTaskScriptPath(env);
	const scriptPath = path.join(resolvePreferredOpenClawTmpDir(), `openclaw-schtasks-restart-${randomUUID()}.cmd`);
	const quotedScriptPath = quoteCmdScriptArg(scriptPath);
	const restartLog = renderCmdRestartLogSetup({
		...process.env,
		...env
	});
	try {
		fs.writeFileSync(scriptPath, `${buildScheduledTaskRestartScript({
			quotedLogPath: restartLog.quotedLogPath,
			setupLines: restartLog.lines,
			taskName,
			taskScriptPath
		})}\r\n`, "utf8");
		spawn("cmd.exe", [
			"/d",
			"/s",
			"/c",
			quotedScriptPath
		], {
			detached: true,
			stdio: "ignore",
			windowsHide: true
		}).unref();
		return {
			ok: true,
			method: "schtasks",
			tried: [`schtasks /Run /TN "${taskName}"`, `cmd.exe /d /s /c ${quotedScriptPath}`]
		};
	} catch (err) {
		try {
			fs.unlinkSync(scriptPath);
		} catch {}
		return {
			ok: false,
			method: "schtasks",
			detail: formatErrorMessage(err),
			tried: [`schtasks /Run /TN "${taskName}"`]
		};
	}
}
//#endregion
//#region src/infra/restart.ts
const SPAWN_TIMEOUT_MS = 2e3;
const SIGUSR1_AUTH_GRACE_MS = 5e3;
const DEFAULT_DEFERRAL_POLL_MS = 500;
const DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS = 3e4;
const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 3e5;
const RESTART_COOLDOWN_MS = 3e4;
const LAUNCHCTL_ALREADY_LOADED_EXIT_CODE = 37;
const GATEWAY_RESTART_INTENT_FILENAME = "gateway-restart-intent.json";
const GATEWAY_RESTART_INTENT_TTL_MS = 6e4;
const GATEWAY_RESTART_INTENT_MAX_BYTES = 1024;
const restartLog = createSubsystemLogger("restart");
let sigusr1AuthorizedCount = 0;
let sigusr1AuthorizedUntil = 0;
let sigusr1ExternalAllowed = false;
let preRestartCheck = null;
let restartCycleToken = 0;
let emittedRestartToken = 0;
let consumedRestartToken = 0;
let emittedRestartReason;
let lastRestartEmittedAt = 0;
let pendingRestartTimer = null;
let pendingRestartDueAt = 0;
let pendingRestartReason;
let pendingRestartEmitHooks;
let pendingRestartSkipDeferral = false;
let pendingRestartPreparing = false;
const activeDeferralPolls = /* @__PURE__ */ new Set();
function shouldPreferRestartReason(next, current) {
	return next === "update.run" && current !== "update.run";
}
function hasUnconsumedRestartSignal() {
	return emittedRestartToken > consumedRestartToken;
}
function clearPendingScheduledRestart() {
	if (pendingRestartTimer) clearTimeout(pendingRestartTimer);
	pendingRestartTimer = null;
	pendingRestartDueAt = 0;
	pendingRestartReason = void 0;
	pendingRestartEmitHooks = void 0;
	pendingRestartSkipDeferral = false;
	pendingRestartPreparing = false;
}
function clearActiveDeferralPolls() {
	for (const poll of activeDeferralPolls) clearInterval(poll);
	activeDeferralPolls.clear();
}
function resetGatewayRestartStateForInProcessRestart() {
	clearActiveDeferralPolls();
	clearPendingScheduledRestart();
}
function resolveGatewayRestartIntentPath(env = process.env) {
	return path.join(resolveStateDir(env), GATEWAY_RESTART_INTENT_FILENAME);
}
function unlinkGatewayRestartIntentFileSync(intentPath) {
	try {
		const stat = fs.lstatSync(intentPath);
		if (!stat.isFile() || stat.nlink > 1) return false;
		fs.unlinkSync(intentPath);
		return true;
	} catch {
		return false;
	}
}
function normalizeRestartIntentPid(pid) {
	return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}
function writeGatewayRestartIntentSync(opts) {
	const targetPid = normalizeRestartIntentPid(opts.targetPid);
	if (targetPid === null) return false;
	const env = opts.env ?? process.env;
	try {
		const intentPath = resolveGatewayRestartIntentPath(env);
		const reason = normalizeRestartIntentReason(opts.reason ?? opts.intent?.reason);
		const payload = {
			kind: "gateway-restart",
			pid: targetPid,
			createdAt: Date.now(),
			...reason ? { reason } : {},
			...opts.intent?.force ? { force: true } : {},
			...typeof opts.intent?.waitMs === "number" && Number.isFinite(opts.intent.waitMs) && opts.intent.waitMs >= 0 ? { waitMs: Math.floor(opts.intent.waitMs) } : {}
		};
		replaceFileAtomicSync({
			filePath: intentPath,
			content: `${JSON.stringify(payload)}\n`,
			mode: 384,
			tempPrefix: ".gateway-restart-intent"
		});
		return true;
	} catch (err) {
		restartLog.warn(`failed to write gateway restart intent: ${String(err)}`);
		return false;
	}
}
function clearGatewayRestartIntentSync(env = process.env) {
	unlinkGatewayRestartIntentFileSync(resolveGatewayRestartIntentPath(env));
}
function parseGatewayRestartIntent(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (parsed.kind === "gateway-restart" && typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) && (parsed.reason === void 0 || typeof parsed.reason === "string") && (parsed.force === void 0 || typeof parsed.force === "boolean") && (parsed.waitMs === void 0 || typeof parsed.waitMs === "number" && Number.isFinite(parsed.waitMs) && parsed.waitMs >= 0)) {
			const reason = normalizeRestartIntentReason(parsed.reason);
			return {
				kind: "gateway-restart",
				pid: parsed.pid,
				createdAt: parsed.createdAt,
				...reason ? { reason } : {},
				...parsed.force ? { force: true } : {},
				...typeof parsed.waitMs === "number" ? { waitMs: Math.floor(parsed.waitMs) } : {}
			};
		}
	} catch {
		return null;
	}
	return null;
}
function normalizeRestartIntentReason(reason) {
	const normalized = reason?.trim();
	return normalized ? normalized.slice(0, 200) : void 0;
}
function consumeGatewayRestartIntentPayloadSync(env = process.env, now = Date.now()) {
	const intentPath = resolveGatewayRestartIntentPath(env);
	let raw;
	try {
		const stat = fs.lstatSync(intentPath);
		if (!stat.isFile() || stat.size > GATEWAY_RESTART_INTENT_MAX_BYTES) return null;
		raw = fs.readFileSync(intentPath, "utf8");
	} catch {
		return null;
	} finally {
		clearGatewayRestartIntentSync(env);
	}
	const payload = parseGatewayRestartIntent(raw);
	if (!payload) return null;
	if (payload.pid !== process.pid) return null;
	const ageMs = now - payload.createdAt;
	if (ageMs < 0 || ageMs > GATEWAY_RESTART_INTENT_TTL_MS) return null;
	return {
		...payload.reason ? { reason: payload.reason } : {},
		...payload.force ? { force: true } : {},
		...typeof payload.waitMs === "number" ? { waitMs: payload.waitMs } : {}
	};
}
function consumeGatewayRestartIntentSync(env = process.env, now = Date.now()) {
	return consumeGatewayRestartIntentPayloadSync(env, now) !== null;
}
function summarizeChangedPaths(paths, maxPaths = 6) {
	if (!Array.isArray(paths) || paths.length === 0) return null;
	if (paths.length <= maxPaths) return paths.join(",");
	return `${paths.slice(0, maxPaths).join(",")},+${paths.length - maxPaths} more`;
}
function formatRestartAudit(audit) {
	const actor = typeof audit?.actor === "string" && audit.actor.trim() ? audit.actor.trim() : null;
	const deviceId = typeof audit?.deviceId === "string" && audit.deviceId.trim() ? audit.deviceId.trim() : null;
	const clientIp = typeof audit?.clientIp === "string" && audit.clientIp.trim() ? audit.clientIp.trim() : null;
	const changed = summarizeChangedPaths(audit?.changedPaths);
	const fields = [];
	if (actor) fields.push(`actor=${actor}`);
	if (deviceId) fields.push(`device=${deviceId}`);
	if (clientIp) fields.push(`ip=${clientIp}`);
	if (changed) fields.push(`changedPaths=${changed}`);
	return fields.length > 0 ? fields.join(" ") : "actor=<unknown>";
}
/**
* Register a callback that scheduleGatewaySigusr1Restart checks before emitting SIGUSR1.
* The callback should return the number of pending items (0 = safe to restart).
*/
function setPreRestartDeferralCheck(fn) {
	preRestartCheck = fn;
}
/**
* Emit an authorized SIGUSR1 gateway restart, guarded against duplicate emissions.
* Returns true if SIGUSR1 was emitted, false if a restart was already emitted.
* Both scheduleGatewaySigusr1Restart and the config watcher should use this
* to ensure only one restart fires.
*/
function emitGatewayRestart(reasonOverride) {
	if (hasUnconsumedRestartSignal()) {
		clearActiveDeferralPolls();
		clearPendingScheduledRestart();
		return false;
	}
	clearActiveDeferralPolls();
	clearPendingScheduledRestart();
	emittedRestartToken = ++restartCycleToken;
	emittedRestartReason = reasonOverride ?? pendingRestartReason;
	authorizeGatewaySigusr1Restart();
	try {
		if (process.listenerCount("SIGUSR1") > 0) process.emit("SIGUSR1");
		else if (process.platform === "win32") {
			if (!triggerOpenClawRestart().ok) {
				rollBackGatewayRestartEmission();
				restartLog.warn("Windows scheduled task restart failed, token rolled back");
				return false;
			}
			consumeGatewaySigusr1RestartAuthorization();
			markGatewaySigusr1RestartHandled();
		} else process.kill(process.pid, "SIGUSR1");
	} catch {
		rollBackGatewayRestartEmission();
		return false;
	}
	lastRestartEmittedAt = Date.now();
	return true;
}
function resetSigusr1AuthorizationIfExpired(now = Date.now()) {
	if (sigusr1AuthorizedCount <= 0) return;
	if (now <= sigusr1AuthorizedUntil) return;
	sigusr1AuthorizedCount = 0;
	sigusr1AuthorizedUntil = 0;
}
function setGatewaySigusr1RestartPolicy(opts) {
	sigusr1ExternalAllowed = opts?.allowExternal === true;
}
function isGatewaySigusr1RestartExternallyAllowed() {
	return sigusr1ExternalAllowed;
}
function authorizeGatewaySigusr1Restart(delayMs = 0) {
	const delay = Math.max(0, Math.floor(delayMs));
	const expiresAt = Date.now() + delay + SIGUSR1_AUTH_GRACE_MS;
	sigusr1AuthorizedCount += 1;
	if (expiresAt > sigusr1AuthorizedUntil) sigusr1AuthorizedUntil = expiresAt;
}
function consumeGatewaySigusr1RestartAuthorization() {
	resetSigusr1AuthorizationIfExpired();
	if (sigusr1AuthorizedCount <= 0) return false;
	sigusr1AuthorizedCount -= 1;
	if (sigusr1AuthorizedCount <= 0) sigusr1AuthorizedUntil = 0;
	return true;
}
function peekGatewaySigusr1RestartReason() {
	return hasUnconsumedRestartSignal() ? emittedRestartReason : void 0;
}
/**
* Mark the currently emitted SIGUSR1 restart cycle as consumed by the run loop.
* This explicitly advances the cycle state instead of resetting emit guards inside
* consumeGatewaySigusr1RestartAuthorization().
*/
function markGatewaySigusr1RestartHandled() {
	if (hasUnconsumedRestartSignal()) {
		consumedRestartToken = emittedRestartToken;
		emittedRestartReason = void 0;
	}
}
function rollBackGatewayRestartEmission() {
	emittedRestartToken = consumedRestartToken;
	emittedRestartReason = void 0;
	consumeGatewaySigusr1RestartAuthorization();
}
function resolveGatewayRestartDeferralTimeoutMs(timeoutMs) {
	if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS;
	if (timeoutMs <= 0) return;
	return Math.floor(timeoutMs);
}
function updatePendingRestartEmitHooks(hooks) {
	if (hooks) pendingRestartEmitHooks = hooks;
}
async function emitPreparedGatewayRestart(hooks, reasonOverride) {
	let nextHooks = hooks ?? pendingRestartEmitHooks;
	if (!hooks) pendingRestartEmitHooks = void 0;
	let preparedHooks;
	while (nextHooks) {
		if (preparedHooks) {
			await preparedHooks.afterEmitRejected?.().catch(() => void 0);
			preparedHooks = void 0;
		}
		try {
			await nextHooks.beforeEmit?.();
			preparedHooks = nextHooks;
		} catch (err) {
			restartLog.warn(`restart preparation failed; restart will continue without it: ${String(err)}`);
		}
		if (hooks) break;
		nextHooks = pendingRestartEmitHooks;
		pendingRestartEmitHooks = void 0;
	}
	if (!emitGatewayRestart(reasonOverride)) await preparedHooks?.afterEmitRejected?.().catch(() => void 0);
}
/**
* Poll pending work until it drains, then emit one restart signal.
* A positive maxWaitMs keeps the old capped behavior for explicit configs.
* Shared by both the direct RPC restart path and the config watcher path.
*/
function deferGatewayRestartUntilIdle(opts) {
	const pollMsRaw = opts.pollMs ?? DEFAULT_DEFERRAL_POLL_MS;
	const pollMs = Math.max(10, Math.floor(pollMsRaw));
	const maxWaitMs = typeof opts.maxWaitMs === "number" && Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs > 0 ? Math.max(pollMs, Math.floor(opts.maxWaitMs)) : void 0;
	let pending;
	try {
		pending = opts.getPendingCount();
	} catch (err) {
		opts.hooks?.onCheckError?.(err);
		emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
		return;
	}
	if (pending <= 0) {
		opts.hooks?.onReady?.();
		emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
		return;
	}
	opts.hooks?.onDeferring?.(pending);
	const startedAt = Date.now();
	let nextStillPendingAt = startedAt + DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS;
	const poll = setInterval(() => {
		let current;
		try {
			current = opts.getPendingCount();
		} catch (err) {
			clearInterval(poll);
			activeDeferralPolls.delete(poll);
			opts.hooks?.onCheckError?.(err);
			emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
			return;
		}
		if (current <= 0) {
			clearInterval(poll);
			activeDeferralPolls.delete(poll);
			opts.hooks?.onReady?.();
			emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
			return;
		}
		const elapsedMs = Date.now() - startedAt;
		if (Date.now() >= nextStillPendingAt) {
			opts.hooks?.onStillPending?.(current, elapsedMs);
			nextStillPendingAt = Date.now() + DEFAULT_DEFERRAL_STILL_PENDING_WARN_MS;
		}
		if (maxWaitMs !== void 0 && elapsedMs >= maxWaitMs) {
			clearInterval(poll);
			activeDeferralPolls.delete(poll);
			opts.hooks?.onTimeout?.(current, elapsedMs);
			emitPreparedGatewayRestart(opts.emitHooks, opts.reason);
		}
	}, pollMs);
	activeDeferralPolls.add(poll);
}
function formatSpawnDetail(result) {
	const clean = (value) => {
		return (typeof value === "string" ? value : value ? value.toString() : "").replace(/\s+/g, " ").trim();
	};
	if (result.error) {
		if (result.error instanceof Error) return result.error.message;
		if (typeof result.error === "string") return result.error;
		try {
			return JSON.stringify(result.error);
		} catch {
			return "unknown error";
		}
	}
	const stderr = clean(result.stderr);
	if (stderr) return stderr;
	const stdout = clean(result.stdout);
	if (stdout) return stdout;
	if (typeof result.status === "number") return `exit ${result.status}`;
	return "unknown error";
}
function normalizeSystemdUnit(raw, profile) {
	const unit = raw?.trim();
	if (!unit) return `${resolveGatewaySystemdServiceName(profile)}.service`;
	return unit.endsWith(".service") ? unit : `${unit}.service`;
}
function triggerOpenClawRestart() {
	if (process.env.VITEST || false) return {
		ok: true,
		method: "supervisor",
		detail: "test mode"
	};
	cleanStaleGatewayProcessesSync();
	const tried = [];
	if (process.platform === "linux") {
		const unit = normalizeSystemdUnit(process.env.OPENCLAW_SYSTEMD_UNIT, process.env.OPENCLAW_PROFILE);
		const userArgs = [
			"--user",
			"restart",
			unit
		];
		tried.push(`systemctl ${userArgs.join(" ")}`);
		const userRestart = spawnSync("systemctl", userArgs, {
			encoding: "utf8",
			timeout: SPAWN_TIMEOUT_MS
		});
		if (!userRestart.error && userRestart.status === 0) return {
			ok: true,
			method: "systemd",
			tried
		};
		const systemArgs = ["restart", unit];
		tried.push(`systemctl ${systemArgs.join(" ")}`);
		const systemRestart = spawnSync("systemctl", systemArgs, {
			encoding: "utf8",
			timeout: SPAWN_TIMEOUT_MS
		});
		if (!systemRestart.error && systemRestart.status === 0) return {
			ok: true,
			method: "systemd",
			tried
		};
		return {
			ok: false,
			method: "systemd",
			detail: [`user: ${formatSpawnDetail(userRestart)}`, `system: ${formatSpawnDetail(systemRestart)}`].join("; "),
			tried
		};
	}
	if (process.platform === "win32") return relaunchGatewayScheduledTask(process.env);
	if (process.platform !== "darwin") return {
		ok: false,
		method: "supervisor",
		detail: "unsupported platform restart"
	};
	const label = process.env.OPENCLAW_LAUNCHD_LABEL || resolveGatewayLaunchAgentLabel(process.env.OPENCLAW_PROFILE);
	const uid = typeof process.getuid === "function" ? process.getuid() : void 0;
	const domain = uid !== void 0 ? `gui/${uid}` : "gui/501";
	const target = `${domain}/${label}`;
	const args = [
		"kickstart",
		"-k",
		target
	];
	tried.push(`launchctl ${args.join(" ")}`);
	const res = spawnSync("launchctl", args, {
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT_MS
	});
	if (!res.error && res.status === 0) return {
		ok: true,
		method: "launchctl",
		tried
	};
	const home = process.env.HOME?.trim() || os.homedir();
	const bootstrapArgs = [
		"bootstrap",
		domain,
		path.join(home, "Library", "LaunchAgents", `${label}.plist`)
	];
	tried.push(`launchctl ${bootstrapArgs.join(" ")}`);
	const boot = spawnSync("launchctl", bootstrapArgs, {
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT_MS
	});
	if (boot.error || boot.status !== 0 && boot.status !== LAUNCHCTL_ALREADY_LOADED_EXIT_CODE && boot.status !== null) return {
		ok: false,
		method: "launchctl",
		detail: formatSpawnDetail(boot),
		tried
	};
	if (boot.status === 0) return {
		ok: true,
		method: "launchctl",
		tried
	};
	const retryArgs = ["kickstart", target];
	tried.push(`launchctl ${retryArgs.join(" ")}`);
	const retry = spawnSync("launchctl", retryArgs, {
		encoding: "utf8",
		timeout: SPAWN_TIMEOUT_MS
	});
	if (!retry.error && retry.status === 0) return {
		ok: true,
		method: "launchctl",
		tried
	};
	return {
		ok: false,
		method: "launchctl",
		detail: formatSpawnDetail(retry),
		tried
	};
}
function scheduleGatewaySigusr1Restart(opts) {
	const delayMsRaw = typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs) ? Math.floor(opts.delayMs) : 2e3;
	const delayMs = Math.min(Math.max(delayMsRaw, 0), 6e4);
	const reason = typeof opts?.reason === "string" && opts.reason.trim() ? opts.reason.trim().slice(0, 200) : void 0;
	const mode = process.listenerCount("SIGUSR1") > 0 ? "emit" : process.platform === "win32" ? "supervisor" : "signal";
	const nowMs = Date.now();
	const cooldownMsApplied = opts?.skipCooldown === true ? 0 : Math.max(0, lastRestartEmittedAt + RESTART_COOLDOWN_MS - nowMs);
	const requestedDueAt = nowMs + delayMs + cooldownMsApplied;
	const skipDeferral = opts?.skipDeferral === true;
	if (hasUnconsumedRestartSignal()) {
		if (shouldPreferRestartReason(reason, emittedRestartReason)) emittedRestartReason = reason;
		restartLog.warn(`restart request coalesced (already in-flight) reason=${reason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`);
		return {
			ok: true,
			pid: process.pid,
			signal: "SIGUSR1",
			delayMs: 0,
			reason,
			mode,
			coalesced: true,
			cooldownMsApplied
		};
	}
	if (pendingRestartTimer || pendingRestartPreparing) {
		const remainingMs = pendingRestartPreparing ? 0 : Math.max(0, pendingRestartDueAt - nowMs);
		if (pendingRestartPreparing && skipDeferral && activeDeferralPolls.size > 0) {
			restartLog.warn(`restart request bypassed active deferral reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} ${formatRestartAudit(opts?.audit)}`);
			clearActiveDeferralPolls();
			pendingRestartReason = reason;
			pendingRestartEmitHooks = opts?.emitHooks;
			emitPreparedGatewayRestart(void 0, reason);
			return {
				ok: true,
				pid: process.pid,
				signal: "SIGUSR1",
				delayMs: 0,
				reason,
				mode,
				coalesced: false,
				cooldownMsApplied
			};
		}
		if (!pendingRestartPreparing && (requestedDueAt < pendingRestartDueAt || skipDeferral && !pendingRestartSkipDeferral)) {
			restartLog.warn(`restart request rescheduled earlier reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} oldDelayMs=${remainingMs} newDelayMs=${Math.max(0, requestedDueAt - nowMs)} ${formatRestartAudit(opts?.audit)}`);
			clearPendingScheduledRestart();
		} else {
			if (shouldPreferRestartReason(reason, pendingRestartReason)) pendingRestartReason = reason;
			pendingRestartSkipDeferral = pendingRestartSkipDeferral || skipDeferral;
			restartLog.warn(`restart request coalesced (already scheduled) reason=${reason ?? "unspecified"} pendingReason=${pendingRestartReason ?? "unspecified"} delayMs=${remainingMs} ${formatRestartAudit(opts?.audit)}`);
			updatePendingRestartEmitHooks(opts?.emitHooks);
			return {
				ok: true,
				pid: process.pid,
				signal: "SIGUSR1",
				delayMs: remainingMs,
				reason,
				mode,
				coalesced: true,
				cooldownMsApplied
			};
		}
	}
	pendingRestartDueAt = requestedDueAt;
	pendingRestartReason = reason;
	pendingRestartEmitHooks = opts?.emitHooks;
	pendingRestartSkipDeferral = skipDeferral;
	pendingRestartTimer = setTimeout(() => {
		const scheduledReason = pendingRestartReason;
		const scheduledSkipDeferral = pendingRestartSkipDeferral;
		pendingRestartTimer = null;
		pendingRestartDueAt = 0;
		pendingRestartReason = void 0;
		pendingRestartSkipDeferral = false;
		pendingRestartPreparing = true;
		const pendingCheck = preRestartCheck;
		if (scheduledSkipDeferral || !pendingCheck) {
			emitPreparedGatewayRestart(void 0, scheduledReason);
			return;
		}
		deferGatewayRestartUntilIdle({
			getPendingCount: pendingCheck,
			maxWaitMs: resolveGatewayRestartDeferralTimeoutMs(getRuntimeConfig().gateway?.reload?.deferralTimeoutMs),
			reason: scheduledReason
		});
	}, Math.max(0, requestedDueAt - nowMs));
	return {
		ok: true,
		pid: process.pid,
		signal: "SIGUSR1",
		delayMs: Math.max(0, requestedDueAt - nowMs),
		reason,
		mode,
		coalesced: false,
		cooldownMsApplied
	};
}
//#endregion
export { deferGatewayRestartUntilIdle as a, markGatewaySigusr1RestartHandled as c, resolveGatewayRestartDeferralTimeoutMs as d, scheduleGatewaySigusr1Restart as f, writeGatewayRestartIntentSync as g, triggerOpenClawRestart as h, consumeGatewaySigusr1RestartAuthorization as i, peekGatewaySigusr1RestartReason as l, setPreRestartDeferralCheck as m, consumeGatewayRestartIntentPayloadSync as n, emitGatewayRestart as o, setGatewaySigusr1RestartPolicy as p, consumeGatewayRestartIntentSync as r, isGatewaySigusr1RestartExternallyAllowed as s, clearGatewayRestartIntentSync as t, resetGatewayRestartStateForInProcessRestart as u };
