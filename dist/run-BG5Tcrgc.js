import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { a as normalizeStateDirEnv, d as resolveGatewayPort, t as CONFIG_PATH, y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { n as inheritOptionFromParent } from "./command-options-Dhjl7AMa.js";
import { s as hasConfiguredSecretInput } from "./types.secrets-DwPik3M8.js";
import { i as GATEWAY_SERVICE_RUNTIME_PID_ENV } from "./constants-CmvvKVqh.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { r as setVerbose } from "./global-state-BAD7XgmL.js";
import "./globals-YU5FjfZK.js";
import { c as setConsoleTimestampPrefix, s as setConsoleSubsystemFilter } from "./console-BAPPAj56.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { i as isLoopbackHost, p as resolveGatewayBindHost, t as defaultGatewayBindMode, v as isContainerEnvironment } from "./net-DCUMtgJy.js";
import { n as formatInvalidConfigPort, r as formatInvalidPortOption } from "./error-format-BfFDdqsq.js";
import { t as parsePort } from "./parse-port-m3bZnoBN.js";
import { i as withDiagnosticPhase } from "./diagnostic-phase-B3JejDeW.js";
import { a as markGatewayRestartTrace, f as startGatewayRestartTrace, o as measureGatewayRestartTrace, r as createGatewayRestartTraceHandoffEnv, t as captureGatewayRestartTraceHandoff } from "./restart-trace-BKGWAIro.js";
import { r as withProgress } from "./progress-CE2g1zbv.js";
import { n as setGatewayWsLogStyle } from "./ws-logging-zK0zdycs.js";
import { n as acquireGatewayLock, t as GatewayLockError } from "./gateway-lock-D08Qdchp.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
//#region src/cli/gateway-cli/qa-parent-watchdog.ts
const QA_PARENT_PID_ENV = "OPENCLAW_QA_PARENT_PID";
const QA_TEMP_ROOT_ENV = "OPENCLAW_QA_TEMP_ROOT";
const QA_STAGED_RUNTIME_ROOT_ENV = "OPENCLAW_QA_STAGED_RUNTIME_ROOT";
const DEFAULT_QA_PARENT_WATCHDOG_INTERVAL_MS = 1e3;
const QA_TEMP_ROOT_PREFIX = "openclaw-qa-suite-";
function resolveQaParentPid(env, ownPid) {
	const raw = env[QA_PARENT_PID_ENV]?.trim();
	if (!raw) return null;
	const parentPid = Number(raw);
	if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || parentPid === ownPid) return null;
	return parentPid;
}
function resolveQaCleanupRoot(rawValue) {
	const raw = rawValue?.trim();
	if (!raw) return null;
	const cleanupRoot = path.resolve(raw);
	if (!path.basename(cleanupRoot).startsWith(QA_TEMP_ROOT_PREFIX)) return null;
	return cleanupRoot;
}
function resolveQaCleanupRoots(env) {
	return [resolveQaCleanupRoot(env[QA_TEMP_ROOT_ENV]), resolveQaCleanupRoot(env[QA_STAGED_RUNTIME_ROOT_ENV])].filter((target, index, array) => {
		return target !== null && array.indexOf(target) === index;
	});
}
function pathContains(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function installQaParentWatchdog(deps = {}) {
	const env = deps.env ?? process.env;
	const parentPid = resolveQaParentPid(env, deps.ownPid ?? process.pid);
	if (parentPid === null) return null;
	const clearIntervalFn = deps.clearInterval ?? ((activeTimer) => {
		clearInterval(activeTimer);
	});
	const exit = deps.exit ?? ((code) => process.exit(code));
	const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
	const logger = deps.logger ?? createSubsystemLogger("gateway");
	const qaCleanupRoots = resolveQaCleanupRoots(env);
	const chdir = deps.chdir ?? ((directory) => process.chdir(directory));
	const cwd = deps.cwd ?? (() => process.cwd());
	const rm = deps.rm ?? (async (target) => {
		await fs$1.rm(target, {
			recursive: true,
			force: true
		});
	});
	const setIntervalFn = deps.setInterval ?? ((callback, ms) => setInterval(callback, ms));
	let stopped = false;
	let exiting = false;
	let timer;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		clearIntervalFn(timer);
	};
	timer = setIntervalFn(() => {
		if (stopped || exiting) return;
		try {
			kill(parentPid, 0);
		} catch (error) {
			if (error.code === "ESRCH") {
				logger.warn(`QA gateway parent pid ${parentPid} exited; shutting down orphaned QA gateway`);
				exiting = true;
				stop();
				(async () => {
					const currentCwd = path.resolve(cwd());
					const activeCwdRoot = qaCleanupRoots.find((cleanupRoot) => pathContains(cleanupRoot, currentCwd));
					if (activeCwdRoot) {
						const safeCwd = path.dirname(activeCwdRoot);
						try {
							chdir(safeCwd);
						} catch (chdirError) {
							logger.warn(`QA gateway parent pid ${parentPid} exited; failed to leave runtime root ${activeCwdRoot}: ${chdirError instanceof Error ? chdirError.message : String(chdirError)}`);
						}
					}
					for (const cleanupRoot of qaCleanupRoots) await rm(cleanupRoot).catch((cleanupError) => {
						logger.warn(`QA gateway parent pid ${parentPid} exited; failed to clean runtime root ${cleanupRoot}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
					});
					exit(0);
				})();
			}
		}
	}, deps.intervalMs ?? DEFAULT_QA_PARENT_WATCHDOG_INTERVAL_MS);
	if (typeof timer === "object") timer.unref?.();
	return {
		parentPid,
		stop
	};
}
//#endregion
//#region src/cli/gateway-cli/run-loop.ts
const gatewayLog$1 = createSubsystemLogger("gateway");
const LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS = 1500;
const DEFAULT_RESTART_DRAIN_TIMEOUT_MS = 3e5;
const RESTART_ACTIVE_EMBEDDED_RUN_ABORT_GRACE_MS = 3e4;
const RESTART_DRAIN_STILL_PENDING_WARN_MS = 3e4;
const RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS = 1e4;
const UPDATE_RESPAWN_HEALTH_TIMEOUT_MS = 1e4;
const UPDATE_RESPAWN_HEALTH_POLL_MS = 200;
const gatewayLifecycleRuntimeLoader = createLazyImportLoader(() => import("./cli/gateway-lifecycle.runtime.js"));
const loadGatewayLifecycleRuntimeModule = () => gatewayLifecycleRuntimeLoader.load();
function createRestartIterationHook(onRestart) {
	let isFirstIteration = true;
	return async () => {
		if (isFirstIteration) {
			isFirstIteration = false;
			return false;
		}
		await onRestart();
		return true;
	};
}
async function waitForGatewayPortReady(host, port) {
	return await new Promise((resolve) => {
		const socket = net.createConnection({
			host,
			port
		});
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.removeAllListeners();
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => {
			finish(false);
		}, UPDATE_RESPAWN_HEALTH_POLL_MS);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}
async function waitForHealthyGatewayChild(port, _pid, host = "127.0.0.1", timeoutMs = UPDATE_RESPAWN_HEALTH_TIMEOUT_MS) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await waitForGatewayPortReady(host, port)) return true;
		await new Promise((resolve) => {
			setTimeout(resolve, UPDATE_RESPAWN_HEALTH_POLL_MS);
		});
	}
	return false;
}
async function runGatewayLoop(params) {
	let startupStartedAt = Date.now();
	const eagerLifecycleRuntime = await loadGatewayLifecycleRuntimeModule();
	let lock = await acquireGatewayLock({ port: params.lockPort });
	let server = null;
	let shuttingDown = false;
	let restartResolver = null;
	let pendingStartupRequest = null;
	let pendingStartupForceExitTimer = null;
	let restartDrainingMarkPromise = null;
	let startupFailedWithoutServerHandle = false;
	const processInstanceId = randomUUID();
	const waitForHealthyChild = params.waitForHealthyChild ?? waitForHealthyGatewayChild;
	const cleanupSignals = () => {
		process.removeListener("SIGTERM", onSigterm);
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGUSR1", onSigusr1);
	};
	const exitProcess = (code) => {
		cleanupSignals();
		params.runtime.exit(code);
	};
	const writeStabilityBundle = async (reason, error) => {
		const { writeDiagnosticStabilityBundleForFailureSync } = await loadGatewayLifecycleRuntimeModule();
		const result = writeDiagnosticStabilityBundleForFailureSync(reason, error);
		if ("message" in result) gatewayLog$1.warn(result.message);
	};
	const releaseLockIfHeld = async () => {
		if (!lock) return false;
		await lock.release();
		lock = null;
		return true;
	};
	const reacquireLockForInProcessRestart = async () => {
		try {
			startupStartedAt = Date.now();
			lock = await acquireGatewayLock({ port: params.lockPort });
			return true;
		} catch (err) {
			gatewayLog$1.error(`failed to reacquire gateway lock for in-process restart: ${String(err)}`);
			exitProcess(1);
			return false;
		}
	};
	const handleRestartAfterServerClose = async (restartReason) => {
		const hadLock = await releaseLockIfHeld();
		const isUpdateRestart = restartReason === "update.run";
		const { detectRespawnSupervisor, markUpdateRestartSentinelFailure, respawnGatewayProcessForUpdate, restartGatewayProcessWithFreshPid, writeGatewayRestartHandoffSync } = await loadGatewayLifecycleRuntimeModule();
		if (isUpdateRestart) {
			const respawn = respawnGatewayProcessForUpdate({ env: createGatewayRestartTraceHandoffEnv(captureGatewayRestartTraceHandoff()) });
			if (respawn.mode === "spawned") {
				const port = params.lockPort;
				if (typeof port === "number" ? await waitForHealthyChild(port, respawn.pid, params.healthHost ?? "127.0.0.1") : false) {
					gatewayLog$1.info(`restart mode: update process respawn (spawned pid ${respawn.pid ?? "unknown"})`);
					exitProcess(0);
					return;
				}
				gatewayLog$1.warn(`update respawn child did not become healthy (${respawn.pid ?? "unknown"}); falling back to in-process restart`);
				try {
					respawn.child?.kill();
				} catch {}
				await markUpdateRestartSentinelFailure("restart-unhealthy").catch((err) => {
					gatewayLog$1.warn(`failed to mark update restart sentinel unhealthy: ${String(err)}`);
				});
				if (hadLock && !await reacquireLockForInProcessRestart()) return;
				shuttingDown = false;
				restartResolver?.();
				return;
			}
			if (respawn.mode === "supervised") {
				const supervisorMode = detectRespawnSupervisor(process.env, process.platform);
				markGatewayRestartTrace("restart.full-process-handoff", [
					["kind", "update-process"],
					["mode", respawn.mode],
					["supervisorMode", supervisorMode ?? "external"]
				]);
				writeGatewayRestartHandoffSync({
					restartKind: "update-process",
					reason: restartReason,
					processInstanceId,
					supervisorMode: supervisorMode ?? "external",
					restartTrace: captureGatewayRestartTraceHandoff()
				});
				gatewayLog$1.info("restart mode: update process respawn (supervisor restart)");
				if (supervisorMode === "launchd") await new Promise((resolve) => {
					setTimeout(resolve, LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS);
				});
				exitProcess(0);
				return;
			}
			if (respawn.mode === "failed") {
				gatewayLog$1.warn(`update respawn failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`);
				await markUpdateRestartSentinelFailure("restart-unhealthy").catch((err) => {
					gatewayLog$1.warn(`failed to mark update restart sentinel unhealthy: ${String(err)}`);
				});
			} else gatewayLog$1.info(`restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`);
			if (!await reacquireLockForInProcessRestart()) return;
			shuttingDown = false;
			restartResolver?.();
			return;
		}
		const respawn = restartGatewayProcessWithFreshPid({ env: createGatewayRestartTraceHandoffEnv(captureGatewayRestartTraceHandoff()) });
		if (respawn.mode === "spawned" || respawn.mode === "supervised") {
			const supervisorMode = respawn.mode === "supervised" ? detectRespawnSupervisor(process.env, process.platform) : null;
			const modeLabel = respawn.mode === "spawned" ? `spawned pid ${respawn.pid ?? "unknown"}` : "supervisor restart";
			markGatewayRestartTrace("restart.full-process-handoff", [
				["kind", "full-process"],
				["mode", respawn.mode],
				["pid", respawn.mode === "spawned" ? respawn.pid ?? "unknown" : "none"],
				["supervisorMode", supervisorMode ?? "none"]
			]);
			if (respawn.mode === "supervised") writeGatewayRestartHandoffSync({
				restartKind: "full-process",
				reason: restartReason,
				processInstanceId,
				supervisorMode: supervisorMode ?? "external",
				restartTrace: captureGatewayRestartTraceHandoff()
			});
			gatewayLog$1.info(`restart mode: full process restart (${modeLabel})`);
			if (supervisorMode === "launchd") await new Promise((resolve) => {
				setTimeout(resolve, LAUNCHD_SUPERVISED_RESTART_EXIT_DELAY_MS);
			});
			exitProcess(0);
			return;
		}
		if (respawn.mode === "failed") {
			await writeStabilityBundle("gateway.restart_respawn_failed");
			gatewayLog$1.warn(`full process restart failed (${respawn.detail ?? "unknown error"}); falling back to in-process restart`);
		} else gatewayLog$1.info(`restart mode: in-process restart (${respawn.detail ?? "OPENCLAW_NO_RESPAWN"})`);
		if (!await reacquireLockForInProcessRestart()) return;
		shuttingDown = false;
		restartResolver?.();
	};
	const handleStopAfterServerClose = async () => {
		await releaseLockIfHeld();
		exitProcess(0);
	};
	const SHUTDOWN_TIMEOUT_MS = 25e3;
	const clearPendingStartupForceExitTimer = () => {
		if (!pendingStartupForceExitTimer) return;
		clearTimeout(pendingStartupForceExitTimer);
		pendingStartupForceExitTimer = null;
	};
	const armPendingStartupForceExitTimer = () => {
		if (pendingStartupForceExitTimer) return;
		pendingStartupForceExitTimer = setTimeout(() => {
			pendingStartupForceExitTimer = null;
			gatewayLog$1.error("startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery");
			(async () => {
				try {
					await writeStabilityBundle("gateway.restart_startup_request_timeout");
				} finally {
					exitProcess(1);
				}
			})();
		}, SHUTDOWN_TIMEOUT_MS);
		pendingStartupForceExitTimer.unref?.();
	};
	const resolveRestartDrainTimeoutMs = async (restartIntent) => {
		if (restartIntent?.force) return 0;
		if (typeof restartIntent?.waitMs === "number" && Number.isFinite(restartIntent.waitMs)) return restartIntent.waitMs > 0 ? Math.floor(restartIntent.waitMs) : void 0;
		try {
			const { getRuntimeConfig, resolveGatewayRestartDeferralTimeoutMs } = await loadGatewayLifecycleRuntimeModule();
			const timeoutMs = getRuntimeConfig().gateway?.reload?.deferralTimeoutMs;
			return resolveGatewayRestartDeferralTimeoutMs(timeoutMs);
		} catch {
			return DEFAULT_RESTART_DRAIN_TIMEOUT_MS;
		}
	};
	const markRestartDraining = async () => {
		if (!restartDrainingMarkPromise) restartDrainingMarkPromise = (async () => {
			const { markGatewayDraining } = await loadGatewayLifecycleRuntimeModule();
			markGatewayDraining();
		})().catch((err) => {
			restartDrainingMarkPromise = null;
			throw err;
		});
		await restartDrainingMarkPromise;
	};
	const runAcceptedRequest = ({ action, restartReason, restartIntent }) => {
		const isRestart = action === "restart";
		let forceExitTimer = null;
		const armForceExitTimer = (forceExitMs) => {
			if (forceExitTimer) return;
			forceExitTimer = setTimeout(() => {
				gatewayLog$1.error("shutdown timed out; exiting without full cleanup");
				(async () => {
					try {
						await writeStabilityBundle(isRestart ? "gateway.restart_shutdown_timeout" : "gateway.stop_shutdown_timeout");
					} finally {
						exitProcess(1);
					}
				})();
			}, forceExitMs);
		};
		const clearForceExitTimer = () => {
			if (!forceExitTimer) return;
			clearTimeout(forceExitTimer);
			forceExitTimer = null;
		};
		(async () => {
			const restartDrainTimeoutMs = isRestart ? await resolveRestartDrainTimeoutMs(restartIntent) : 0;
			const restartDrainDeadlineAt = isRestart && restartDrainTimeoutMs !== void 0 ? Date.now() + restartDrainTimeoutMs : void 0;
			if (!isRestart) armForceExitTimer(SHUTDOWN_TIMEOUT_MS);
			else if (restartDrainTimeoutMs !== void 0) armForceExitTimer(restartDrainTimeoutMs + SHUTDOWN_TIMEOUT_MS);
			const formatRestartDrainBudget = () => restartDrainTimeoutMs === void 0 ? "without a timeout" : `with timeout ${restartDrainTimeoutMs}ms`;
			const resolveActiveRunDrainWaitMs = (activeRuns) => {
				if (activeRuns <= 0) return restartDrainTimeoutMs;
				if (restartDrainTimeoutMs === void 0) return RESTART_ACTIVE_EMBEDDED_RUN_ABORT_GRACE_MS;
				return Math.min(restartDrainTimeoutMs, RESTART_ACTIVE_EMBEDDED_RUN_ABORT_GRACE_MS);
			};
			const armCloseForceExitTimerForIndefiniteRestart = () => {
				if (isRestart && restartDrainTimeoutMs === void 0) armForceExitTimer(SHUTDOWN_TIMEOUT_MS);
			};
			const resolveRestartCloseDrainTimeoutMs = () => {
				if (!isRestart) return null;
				if (restartDrainTimeoutMs === void 0) return Math.max(0, SHUTDOWN_TIMEOUT_MS - RESTART_CLOSE_REPLY_DRAIN_SHUTDOWN_RESERVE_MS);
				return Math.max(0, (restartDrainDeadlineAt ?? Date.now()) - Date.now());
			};
			try {
				if (isRestart) {
					let activeTasksAtDrainStart = 0;
					let activeRunsAtDrainStart = 0;
					let drainTimedOut = false;
					await measureGatewayRestartTrace("restart.drain", async () => {
						const { abortEmbeddedPiRun, getRuntimeConfig, getInspectableActiveTaskRestartBlockers, getActiveEmbeddedRunCount, getActiveTaskCount, listActiveEmbeddedRunSessionIds, listActiveEmbeddedRunSessionKeys, markRestartAbortedMainSessions, waitForActiveEmbeddedRuns, waitForActiveTasks } = await loadGatewayLifecycleRuntimeModule();
						const collectActiveRestartSessionKeys = () => {
							return new Set(listActiveEmbeddedRunSessionKeys());
						};
						const collectActiveRestartSessionIds = () => {
							return new Set(listActiveEmbeddedRunSessionIds());
						};
						let activeRestartSessionKeysAtDrainStart = /* @__PURE__ */ new Set();
						let activeRestartSessionIdsAtDrainStart = /* @__PURE__ */ new Set();
						const markActiveMainSessionsForRestart = async (reason) => {
							const sessionKeys = new Set([...activeRestartSessionKeysAtDrainStart, ...collectActiveRestartSessionKeys()]);
							const sessionIds = new Set([...activeRestartSessionIdsAtDrainStart, ...collectActiveRestartSessionIds()]);
							if (sessionKeys.size === 0 && sessionIds.size === 0) return;
							try {
								await markRestartAbortedMainSessions({
									cfg: getRuntimeConfig(),
									sessionKeys,
									sessionIds,
									reason
								});
							} catch (err) {
								gatewayLog$1.warn(`failed to mark interrupted main sessions for restart recovery: ${String(err)}`);
							}
						};
						const formatTaskBlockers = () => {
							const blockers = getInspectableActiveTaskRestartBlockers();
							if (blockers.length === 0) return null;
							const shown = blockers.slice(0, 8).map((task) => [
								`taskId=${task.taskId}`,
								task.runId ? `runId=${task.runId}` : null,
								`status=${task.status}`,
								`runtime=${task.runtime}`,
								task.label ? `label=${task.label}` : null,
								task.title ? `title=${task.title.slice(0, 80)}` : null
							].filter((value) => Boolean(value)).join(" "));
							const omitted = blockers.length - shown.length;
							return omitted > 0 ? `${shown.join("; ")}; +${omitted} more` : shown.join("; ");
						};
						const createStillPendingDrainLogger = () => setInterval(() => {
							gatewayLog$1.warn(`still draining ${getActiveTaskCount()} active task(s) and ${getActiveEmbeddedRunCount()} active embedded run(s) before restart`);
						}, RESTART_DRAIN_STILL_PENDING_WARN_MS);
						await markRestartDraining();
						const activeTasks = getActiveTaskCount();
						const activeRuns = getActiveEmbeddedRunCount();
						activeTasksAtDrainStart = activeTasks;
						activeRunsAtDrainStart = activeRuns;
						activeRestartSessionKeysAtDrainStart = collectActiveRestartSessionKeys();
						activeRestartSessionIdsAtDrainStart = collectActiveRestartSessionIds();
						if (activeRuns > 0) abortEmbeddedPiRun(void 0, { mode: "compacting" });
						if (activeTasks > 0 || activeRuns > 0) {
							const taskBlockers = formatTaskBlockers();
							gatewayLog$1.info(`draining ${activeTasks} active task(s) and ${activeRuns} active embedded run(s) before restart ${formatRestartDrainBudget()}`);
							if (taskBlockers) gatewayLog$1.warn(`restart blocked by active background task run(s): ${taskBlockers}`);
							if (restartIntent?.force) {
								gatewayLog$1.warn("forced restart requested; skipping active work drain");
								await markActiveMainSessionsForRestart("forced gateway restart");
								abortEmbeddedPiRun(void 0, { mode: "all" });
							} else {
								const activeRunDrainWaitMs = resolveActiveRunDrainWaitMs(activeRuns);
								const stillPendingDrainLogger = createStillPendingDrainLogger();
								let abortedAfterRunGrace = false;
								let tasksDrain = { drained: true };
								let runsDrain = { drained: true };
								try {
									const tasksDrainPromise = activeTasks > 0 ? waitForActiveTasks(restartDrainTimeoutMs) : Promise.resolve({ drained: true });
									runsDrain = activeRuns > 0 ? await waitForActiveEmbeddedRuns(activeRunDrainWaitMs) : { drained: true };
									if (!runsDrain.drained && activeRuns > 0) {
										gatewayLog$1.warn("active embedded run drain grace reached; aborting active run(s) before restart");
										abortEmbeddedPiRun(void 0, { mode: "all" });
										abortedAfterRunGrace = true;
									}
									tasksDrain = await tasksDrainPromise;
								} finally {
									clearInterval(stillPendingDrainLogger);
								}
								if (tasksDrain.drained && runsDrain.drained) gatewayLog$1.info("all active work drained");
								else {
									drainTimedOut = true;
									gatewayLog$1.warn("drain timeout reached; proceeding with restart");
									await markActiveMainSessionsForRestart("gateway restart drain timeout");
									if (!abortedAfterRunGrace) abortEmbeddedPiRun(void 0, { mode: "all" });
								}
							}
						}
					}, () => [
						["activeTasks", activeTasksAtDrainStart],
						["activeRuns", activeRunsAtDrainStart],
						["timedOut", drainTimedOut],
						["force", restartIntent?.force === true]
					]);
				}
				armCloseForceExitTimerForIndefiniteRestart();
				const closeDrainTimeoutMs = resolveRestartCloseDrainTimeoutMs();
				await server?.close({
					reason: isRestart ? "gateway restarting" : "gateway stopping",
					restartExpectedMs: isRestart ? 1500 : null,
					...closeDrainTimeoutMs !== null ? { drainTimeoutMs: closeDrainTimeoutMs } : {}
				});
			} catch (err) {
				gatewayLog$1.error(`shutdown error: ${String(err)}`);
			} finally {
				clearForceExitTimer();
				server = null;
				if (isRestart) await handleRestartAfterServerClose(restartReason);
				else await handleStopAfterServerClose();
			}
		})();
	};
	const flushPendingStartupRequest = (opts = {}) => {
		if (!pendingStartupRequest || !restartResolver) return;
		if (!server && opts.allowMissingServer !== true) return;
		const request = pendingStartupRequest;
		pendingStartupRequest = null;
		clearPendingStartupForceExitTimer();
		startupFailedWithoutServerHandle = false;
		runAcceptedRequest(request);
	};
	const request = (action, signal, restartReason, restartIntent) => {
		const acceptedRequest = {
			action,
			signal,
			restartReason,
			restartIntent
		};
		if (shuttingDown) {
			if (action === "stop" && pendingStartupRequest && !server) {
				gatewayLog$1.info(`received ${signal}; overriding pending startup restart with shutdown`);
				pendingStartupRequest = null;
				clearPendingStartupForceExitTimer();
				startupFailedWithoutServerHandle = false;
				runAcceptedRequest(acceptedRequest);
				return;
			}
			gatewayLog$1.info(`received ${signal} during shutdown; ignoring`);
			return;
		}
		shuttingDown = true;
		const isRestart = action === "restart";
		gatewayLog$1.info(`received ${signal}; ${isRestart ? "restarting" : "shutting down"}`);
		if (isRestart) startGatewayRestartTrace("restart.signal.received", [
			["signal", signal],
			["reason", restartReason ?? signal],
			["force", restartIntent?.force === true],
			["waitMs", restartIntent?.waitMs ?? "default"]
		]);
		if (action === "stop") {
			runAcceptedRequest(acceptedRequest);
			return;
		}
		if (!server && restartResolver && startupFailedWithoutServerHandle) {
			startupFailedWithoutServerHandle = false;
			runAcceptedRequest(acceptedRequest);
			return;
		}
		if (!server || !restartResolver) {
			pendingStartupRequest = acceptedRequest;
			markRestartDraining().catch((err) => {
				gatewayLog$1.warn(`failed to mark gateway draining for startup restart: ${String(err)}`);
			});
			armPendingStartupForceExitTimer();
			return;
		}
		runAcceptedRequest(acceptedRequest);
	};
	const onSigterm = () => {
		gatewayLog$1.info("signal SIGTERM received");
		(async () => {
			const { consumeGatewayRestartIntentPayloadSync } = await loadGatewayLifecycleRuntimeModule();
			const restartIntent = consumeGatewayRestartIntentPayloadSync();
			request(restartIntent ? "restart" : "stop", "SIGTERM", restartIntent?.reason, restartIntent ?? void 0);
		})().catch((err) => {
			gatewayLog$1.error(`failed to handle SIGTERM: ${String(err)}`);
			request("stop", "SIGTERM");
		});
	};
	const onSigint = () => {
		gatewayLog$1.info("signal SIGINT received");
		request("stop", "SIGINT");
	};
	const onSigusr1 = () => {
		gatewayLog$1.info("signal SIGUSR1 received");
		(async () => {
			const { consumeGatewayRestartIntentPayloadSync, consumeGatewaySigusr1RestartAuthorization, isGatewaySigusr1RestartExternallyAllowed, markGatewaySigusr1RestartHandled, peekGatewaySigusr1RestartReason, scheduleGatewaySigusr1Restart } = await loadGatewayLifecycleRuntimeModule();
			const restartIntent = consumeGatewayRestartIntentPayloadSync();
			if (restartIntent) {
				request("restart", "SIGUSR1", restartIntent.reason ?? "gateway.restart", restartIntent);
				return;
			}
			if (!consumeGatewaySigusr1RestartAuthorization()) {
				markGatewaySigusr1RestartHandled();
				if (!isGatewaySigusr1RestartExternallyAllowed()) {
					gatewayLog$1.warn("SIGUSR1 restart ignored (not authorized; commands.restart=false or use gateway tool).");
					return;
				}
				if (shuttingDown) {
					gatewayLog$1.info("received SIGUSR1 during shutdown; ignoring");
					return;
				}
				scheduleGatewaySigusr1Restart({
					delayMs: 0,
					reason: "SIGUSR1"
				});
				return;
			}
			const restartReason = peekGatewaySigusr1RestartReason();
			markGatewaySigusr1RestartHandled();
			request("restart", "SIGUSR1", restartReason);
		})().catch((err) => {
			gatewayLog$1.error(`SIGUSR1 handler failed: ${formatErrorMessage(err)}`);
			try {
				eagerLifecycleRuntime.markGatewaySigusr1RestartHandled();
			} catch {}
		});
	};
	process.on("SIGTERM", onSigterm);
	process.on("SIGINT", onSigint);
	process.on("SIGUSR1", onSigusr1);
	try {
		const onIteration = createRestartIterationHook(async () => {
			const { reloadTaskRegistryFromStore, resetAllLanes, resetGatewayRestartStateForInProcessRestart } = await loadGatewayLifecycleRuntimeModule();
			resetAllLanes();
			resetGatewayRestartStateForInProcessRestart();
			reloadTaskRegistryFromStore();
			markGatewayRestartTrace("restart.next-start");
		});
		let isFirstStart = true;
		for (;;) {
			await onIteration();
			restartDrainingMarkPromise = null;
			let startupFailedBeforeServerHandle = false;
			try {
				server = await params.start({ startupStartedAt });
				startupFailedWithoutServerHandle = false;
				isFirstStart = false;
			} catch (err) {
				if (isFirstStart) throw err;
				server = null;
				startupFailedWithoutServerHandle = true;
				startupFailedBeforeServerHandle = true;
				if (!pendingStartupRequest) await releaseLockIfHeld();
				const errMsg = formatErrorMessage(err);
				const errStack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
				await writeStabilityBundle("gateway.restart_startup_failed", err);
				gatewayLog$1.error(`gateway startup failed: ${errMsg}. Process will stay alive; fix the issue and restart.${errStack}`);
			}
			await new Promise((resolve) => {
				restartResolver = () => {
					restartResolver = null;
					resolve();
				};
				flushPendingStartupRequest({ allowMissingServer: startupFailedBeforeServerHandle });
			});
		}
	} finally {
		await releaseLockIfHeld();
		cleanupSignals();
	}
}
//#endregion
//#region src/cli/gateway-cli/run.ts
const gatewayLog = createSubsystemLogger("gateway");
const GATEWAY_RUN_VALUE_KEYS = [
	"port",
	"bind",
	"token",
	"auth",
	"password",
	"passwordFile",
	"tailscale",
	"wsLog",
	"rawStreamPath"
];
const GATEWAY_RUN_BOOLEAN_KEYS = [
	"tailscaleResetOnExit",
	"allowUnconfigured",
	"dev",
	"reset",
	"force",
	"verbose",
	"cliBackendLogs",
	"claudeCliLogs",
	"compact",
	"rawStream"
];
const SUPERVISED_GATEWAY_LOCK_RETRY_MS = 5e3;
const SUPERVISED_GATEWAY_LOCK_RETRY_TIMEOUT_MS = 3e4;
const SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS = 1e3;
/**
* EX_CONFIG (78) from sysexits.h — used for configuration errors so systemd
* (via RestartPreventExitStatus=78) stops restarting instead of entering a
* restart storm that can render low-resource hosts unresponsive.
*/
const EXIT_CONFIG_ERROR = 78;
const GATEWAY_AUTH_MODES = [
	"none",
	"token",
	"password",
	"trusted-proxy"
];
const GATEWAY_TAILSCALE_MODES = [
	"off",
	"serve",
	"funnel"
];
const toOptionString = (value) => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") return value.toString();
};
function extractGatewayMiskeys(parsed) {
	if (!parsed || typeof parsed !== "object") return {
		hasGatewayToken: false,
		hasRemoteToken: false
	};
	const gateway = parsed.gateway;
	if (!gateway || typeof gateway !== "object") return {
		hasGatewayToken: false,
		hasRemoteToken: false
	};
	const hasGatewayToken = "token" in gateway;
	const remote = gateway.remote;
	return {
		hasGatewayToken,
		hasRemoteToken: remote && typeof remote === "object" ? "token" in remote : false
	};
}
function createGatewayCliStartupTrace() {
	const enabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
	const started = performance.now();
	let last = started;
	const emit = (name, durationMs, totalMs) => {
		if (enabled) gatewayLog.info(`startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms`);
	};
	return {
		mark(name) {
			const now = performance.now();
			emit(name, now - last, now - started);
			last = now;
		},
		async measure(name, run) {
			const before = performance.now();
			try {
				return await withDiagnosticPhase(name, run);
			} finally {
				const now = performance.now();
				emit(name, now - before, now - started);
				last = now;
			}
		}
	};
}
function warnInlinePasswordFlag() {
	defaultRuntime.error("Warning: --password can be exposed via process listings. Prefer --password-file or OPENCLAW_GATEWAY_PASSWORD.");
}
async function resolveGatewayPasswordOption(opts) {
	const direct = toOptionString(opts.password);
	const file = toOptionString(opts.passwordFile);
	if (direct && file) throw new Error("Use either --password or --password-file.");
	if (file) {
		const { readSecretFromFile } = await import("./secret-file-BeOJeBX4.js");
		return readSecretFromFile(file, "Gateway password");
	}
	return direct;
}
function parseEnumOption(raw, allowed) {
	if (!raw) return null;
	return allowed.includes(raw) ? raw : null;
}
function formatModeErrorList(modes) {
	const quoted = modes.map((mode) => `"${mode}"`);
	if (quoted.length === 0) return "";
	if (quoted.length === 1) return quoted[0];
	if (quoted.length === 2) return `${quoted[0]} or ${quoted[1]}`;
	return `${quoted.slice(0, -1).join(", ")}, or ${quoted[quoted.length - 1]}`;
}
function shouldBlockGatewayBindWithoutExplicitAuth(params) {
	return !isLoopbackHost(params.bindHost) && !params.hasSharedSecret && params.resolvedAuthMode !== "trusted-proxy";
}
async function maybeLogPendingControlUiBuild(cfg) {
	if (cfg.gateway?.controlUi?.enabled === false) return;
	if (toOptionString(cfg.gateway?.controlUi?.root)) return;
	const { resolveControlUiRootSync } = await import("./control-ui-assets-yRmvns2q.js");
	if (resolveControlUiRootSync({
		moduleUrl: import.meta.url,
		argv1: process.argv[1],
		cwd: process.cwd()
	})) return;
	gatewayLog.info("Control UI assets are missing; first startup may spend a few seconds building them before the gateway binds. `pnpm gateway:watch` does not rebuild Control UI assets, so rerun `pnpm ui:build` after UI changes or use `pnpm ui:dev` while developing the Control UI. For a full local dist, run `pnpm build && pnpm ui:build`.");
}
function getGatewayStartGuardErrors(params) {
	if (params.allowUnconfigured || params.mode === "local") return [];
	if (!params.configExists) return [`Missing config. Run \`${formatCliCommand("openclaw setup")}\` or set gateway.mode=local (or pass --allow-unconfigured).`];
	if (params.mode === void 0) return [[
		"Gateway start blocked: existing config is missing gateway.mode.",
		"Treat this as suspicious or clobbered config.",
		`Re-run \`${formatCliCommand("openclaw onboard --mode local")}\` or \`${formatCliCommand("openclaw setup")}\`, set gateway.mode=local manually, or pass --allow-unconfigured.`
	].join(" "), `Config write audit: ${params.configAuditPath}`];
	return [`Gateway start blocked: set gateway.mode=local (current: ${params.mode}) or pass --allow-unconfigured.`, `Config write audit: ${params.configAuditPath}`];
}
async function readGatewayStartupConfig(params) {
	const { readConfigFileSnapshotWithPluginMetadata } = await import("./config/config.js");
	const snapshotRead = await params.startupTrace.measure("cli.config-snapshot", () => readConfigFileSnapshotWithPluginMetadata().catch(() => null));
	const snapshot = snapshotRead?.snapshot ?? null;
	return {
		cfg: snapshot?.config ?? {},
		snapshot,
		...snapshotRead ? { startupConfigSnapshotRead: snapshotRead } : {}
	};
}
function resolveGatewayRunOptions(opts, command) {
	const resolved = { ...opts };
	for (const key of GATEWAY_RUN_VALUE_KEYS) {
		const inherited = inheritOptionFromParent(command, key);
		if (key === "wsLog") {
			resolved[key] = inherited ?? resolved[key];
			continue;
		}
		resolved[key] = resolved[key] ?? inherited;
	}
	for (const key of GATEWAY_RUN_BOOLEAN_KEYS) {
		const inherited = inheritOptionFromParent(command, key);
		resolved[key] = Boolean(resolved[key] || inherited);
	}
	return resolved;
}
function isGatewayLockError(err) {
	return err instanceof GatewayLockError || !!err && typeof err === "object" && err.name === "GatewayLockError";
}
function isGatewayAlreadyRunningLockError(err) {
	if (!isGatewayLockError(err) || typeof err.message !== "string") return false;
	return err.message.includes("gateway already running") || err.message.includes("another gateway instance is already listening");
}
function isHealthyGatewayLockError(err) {
	return isGatewayAlreadyRunningLockError(err);
}
function resolveGatewayLockErrorExitCode(err, supervisor) {
	if (supervisor === "systemd" && isGatewayAlreadyRunningLockError(err)) return EXIT_CONFIG_ERROR;
	return isHealthyGatewayLockError(err) ? 0 : 1;
}
function normalizeGatewayHealthProbeHost(host) {
	if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
	return host;
}
async function probeGatewayHealthz(params) {
	const timeoutMs = params.timeoutMs ?? SUPERVISED_GATEWAY_HEALTH_PROBE_TIMEOUT_MS;
	return await new Promise((resolve) => {
		const req = request({
			hostname: normalizeGatewayHealthProbeHost(params.host),
			port: params.port,
			path: "/healthz",
			method: "GET",
			timeout: timeoutMs
		}, (res) => {
			res.resume();
			resolve(typeof res.statusCode === "number" && res.statusCode < 500);
		});
		req.once("timeout", () => {
			req.destroy();
			resolve(false);
		});
		req.once("error", () => {
			resolve(false);
		});
		req.end();
	});
}
async function runGatewayLoopWithSupervisedLockRecovery(params) {
	const supervisor = params.supervisor;
	if (!supervisor) {
		await params.startLoop();
		return;
	}
	const now = params.now ?? Date.now;
	const sleep = params.sleep ?? (async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)));
	const probeHealth = params.probeHealth ?? ((probeParams) => probeGatewayHealthz(probeParams));
	const retryMs = params.retryMs ?? SUPERVISED_GATEWAY_LOCK_RETRY_MS;
	const timeoutMs = params.timeoutMs ?? SUPERVISED_GATEWAY_LOCK_RETRY_TIMEOUT_MS;
	const startedAt = now();
	for (;;) try {
		await params.startLoop();
		return;
	} catch (err) {
		if (!isGatewayAlreadyRunningLockError(err)) throw err;
		if (await probeHealth({
			host: params.healthHost,
			port: params.port
		})) {
			if (supervisor === "systemd") throw new GatewayLockError("gateway already running under systemd; existing gateway is healthy, exiting with code 78 to prevent a systemd Restart=always loop", err);
			params.log.info(`gateway already running under ${supervisor}; existing gateway is healthy, leaving it in control`);
			return;
		}
		const elapsedMs = now() - startedAt;
		if (elapsedMs >= timeoutMs) throw new GatewayLockError(`gateway already running under ${supervisor}; existing gateway did not become healthy after ${timeoutMs}ms`, err);
		const waitMs = Math.min(retryMs, Math.max(0, timeoutMs - elapsedMs));
		params.log.warn(`gateway already running under ${supervisor}; waiting ${waitMs}ms before retrying startup`);
		await sleep(waitMs);
	}
}
async function maybeWriteGatewayStartupFailureBundle(err) {
	const { writeDiagnosticStabilityBundleForFailureSync } = await import("./diagnostic-stability-bundle-DeLnngGe.js");
	const result = writeDiagnosticStabilityBundleForFailureSync("gateway.startup_failed", err);
	if ("message" in result) gatewayLog.warn(result.message);
}
async function runGatewayCommand(opts) {
	normalizeStateDirEnv(process.env);
	installQaParentWatchdog();
	if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) process.env[GATEWAY_SERVICE_RUNTIME_PID_ENV] = String(process.pid);
	const isDevProfile = normalizeOptionalLowercaseString(process.env.OPENCLAW_PROFILE) === "dev";
	const devMode = Boolean(opts.dev) || isDevProfile;
	if (opts.reset && !devMode) {
		defaultRuntime.error("Use --reset with --dev.");
		defaultRuntime.exit(1);
		return;
	}
	setVerbose(Boolean(opts.verbose));
	if (opts.cliBackendLogs || opts.claudeCliLogs) {
		setConsoleSubsystemFilter(["agent/cli-backend"]);
		process.env.OPENCLAW_CLI_BACKEND_LOG_OUTPUT = "1";
	}
	const wsLogRaw = opts.compact ? "compact" : opts.wsLog;
	const wsLogStyle = wsLogRaw === "compact" ? "compact" : wsLogRaw === "full" ? "full" : "auto";
	if (wsLogRaw !== void 0 && wsLogRaw !== "auto" && wsLogRaw !== "compact" && wsLogRaw !== "full") {
		defaultRuntime.error("Invalid --ws-log. Use \"auto\", \"full\", or \"compact\".");
		defaultRuntime.exit(1);
	}
	setGatewayWsLogStyle(wsLogStyle);
	if (opts.rawStream) process.env.OPENCLAW_RAW_STREAM = "1";
	const rawStreamPath = toOptionString(opts.rawStreamPath);
	if (rawStreamPath) process.env.OPENCLAW_RAW_STREAM_PATH = rawStreamPath;
	const startupTrace = createGatewayCliStartupTrace();
	const { startGatewayServer } = await startupTrace.measure("cli.server-import", () => withProgress({
		label: "Loading gateway modules…",
		indeterminate: true
	}, async () => import("./server-Dsb8eOGf.js")));
	setConsoleTimestampPrefix(true);
	if (devMode) {
		const { ensureDevGatewayConfig } = await import("./dev-BlbvOGvh.js");
		await startupTrace.measure("cli.dev-config", () => ensureDevGatewayConfig({ reset: Boolean(opts.reset) }));
	}
	gatewayLog.info("loading configuration…");
	const { cfg, snapshot, startupConfigSnapshotRead } = await readGatewayStartupConfig({ startupTrace });
	maybeLogPendingControlUiBuild(cfg).catch((err) => {
		gatewayLog.warn(`Control UI asset check failed: ${String(err)}`);
	});
	const portOverride = parsePort(opts.port);
	if (opts.port !== void 0 && portOverride === null) {
		defaultRuntime.error(formatInvalidPortOption("--port"));
		defaultRuntime.exit(1);
		return;
	}
	const port = portOverride ?? resolveGatewayPort(cfg);
	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		defaultRuntime.error(formatInvalidConfigPort("gateway.port"));
		defaultRuntime.exit(1);
		return;
	}
	const { formatFutureConfigActionBlock, resolveFutureConfigActionBlock } = await import("./future-version-guard-DdZ9steo.js");
	const futureStartupBlock = resolveFutureConfigActionBlock({
		action: "start the gateway service",
		snapshot
	});
	if (futureStartupBlock && process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
		defaultRuntime.error(formatFutureConfigActionBlock(futureStartupBlock));
		defaultRuntime.exit(78);
		return;
	}
	const futureForceBlock = opts.force ? resolveFutureConfigActionBlock({
		action: "force-kill gateway port listeners",
		snapshot
	}) : null;
	if (futureForceBlock) {
		defaultRuntime.error(formatFutureConfigActionBlock(futureForceBlock));
		defaultRuntime.exit(1);
		return;
	}
	const VALID_BIND_MODES = new Set([
		"loopback",
		"lan",
		"auto",
		"custom",
		"tailnet"
	]);
	const bindExplicitRawStr = normalizeOptionalString(toOptionString(opts.bind) ?? cfg.gateway?.bind);
	if (bindExplicitRawStr !== void 0 && !VALID_BIND_MODES.has(bindExplicitRawStr)) {
		defaultRuntime.error("Invalid --bind. Use \"loopback\", \"lan\", \"tailnet\", \"auto\", or \"custom\".");
		defaultRuntime.exit(1);
		return;
	}
	const bindExplicitRaw = bindExplicitRawStr;
	if (process.env.OPENCLAW_SERVICE_MARKER?.trim()) {
		const { cleanStaleGatewayProcessesSync } = await import("./restart-stale-pids-CE3pExtF.js");
		const stale = cleanStaleGatewayProcessesSync(port);
		if (stale.length > 0) gatewayLog.info(`service-mode: cleared ${stale.length} stale gateway pid(s) before bind on port ${port}`);
	}
	if (opts.force) try {
		const { forceFreePortAndWait, waitForPortBindable } = await import("./ports-Bc7dLDGr.js");
		const { killed, waitedMs, escalatedToSigkill } = await forceFreePortAndWait(port, {
			timeoutMs: 2e3,
			intervalMs: 100,
			sigtermTimeoutMs: 700
		});
		if (killed.length === 0) gatewayLog.info(`force: no listeners on port ${port}`);
		else {
			for (const proc of killed) gatewayLog.info(`force: killed pid ${proc.pid}${proc.command ? ` (${proc.command})` : ""} on port ${port}`);
			if (escalatedToSigkill) gatewayLog.info(`force: escalated to SIGKILL while freeing port ${port}`);
			if (waitedMs > 0) gatewayLog.info(`force: waited ${waitedMs}ms for port ${port} to free`);
		}
		const bindWaitMs = await waitForPortBindable(port, {
			timeoutMs: 3e3,
			intervalMs: 150,
			host: bindExplicitRaw === "loopback" ? "127.0.0.1" : bindExplicitRaw === "lan" ? "0.0.0.0" : bindExplicitRaw === "custom" ? toOptionString(cfg.gateway?.customBindHost) : void 0
		});
		if (bindWaitMs > 0) gatewayLog.info(`force: waited ${bindWaitMs}ms for port ${port} to become bindable`);
	} catch (err) {
		defaultRuntime.error(`Could not free port ${port}: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} to inspect the listener.`);
		defaultRuntime.exit(1);
		return;
	}
	if (opts.token) {
		const token = toOptionString(opts.token);
		if (token) process.env.OPENCLAW_GATEWAY_TOKEN = token;
	}
	const authModeRaw = toOptionString(opts.auth);
	const authMode = parseEnumOption(authModeRaw, GATEWAY_AUTH_MODES);
	if (authModeRaw && !authMode) {
		defaultRuntime.error(`Invalid --auth. Use ${formatModeErrorList(GATEWAY_AUTH_MODES)}.`);
		defaultRuntime.exit(1);
		return;
	}
	const tailscaleRaw = toOptionString(opts.tailscale);
	const tailscaleMode = parseEnumOption(tailscaleRaw, GATEWAY_TAILSCALE_MODES);
	if (tailscaleRaw && !tailscaleMode) {
		defaultRuntime.error(`Invalid --tailscale. Use ${formatModeErrorList(GATEWAY_TAILSCALE_MODES)}.`);
		defaultRuntime.exit(1);
		return;
	}
	const effectiveTailscaleMode = tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off";
	const bind = bindExplicitRaw ?? defaultGatewayBindMode(effectiveTailscaleMode);
	let passwordRaw;
	try {
		passwordRaw = await resolveGatewayPasswordOption(opts);
	} catch (err) {
		defaultRuntime.error(formatErrorMessage(err));
		defaultRuntime.exit(1);
		return;
	}
	if (toOptionString(opts.password)) warnInlinePasswordFlag();
	const tokenRaw = toOptionString(opts.token);
	gatewayLog.info("resolving authentication…");
	const configExists = snapshot?.exists ?? fs.existsSync(CONFIG_PATH);
	const configAuditPath = path.join(resolveStateDir(process.env), "logs", "config-audit.jsonl");
	const mode = (snapshot?.valid ? snapshot.config : cfg).gateway?.mode;
	const guardErrors = getGatewayStartGuardErrors({
		allowUnconfigured: opts.allowUnconfigured,
		configExists,
		configAuditPath,
		mode
	});
	if (guardErrors.length > 0) {
		for (const error of guardErrors) defaultRuntime.error(error);
		defaultRuntime.exit(EXIT_CONFIG_ERROR);
		return;
	}
	const miskeys = extractGatewayMiskeys(snapshot?.parsed);
	const authOverride = authMode || passwordRaw || tokenRaw || authModeRaw ? {
		...authMode ? { mode: authMode } : {},
		...tokenRaw ? { token: tokenRaw } : {},
		...passwordRaw ? { password: passwordRaw } : {}
	} : void 0;
	const { resolveGatewayAuth } = await import("./auth-C8xGsLhe.js");
	const resolvedAuth = await startupTrace.measure("cli.auth-resolve", () => resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		authOverride,
		env: process.env,
		tailscaleMode: tailscaleMode ?? cfg.gateway?.tailscale?.mode ?? "off"
	}));
	const resolvedAuthMode = resolvedAuth.mode;
	const tokenValue = resolvedAuth.token;
	const passwordValue = resolvedAuth.password;
	const hasToken = typeof tokenValue === "string" && tokenValue.trim().length > 0;
	const hasPassword = typeof passwordValue === "string" && passwordValue.trim().length > 0;
	const tokenConfigured = hasToken || hasConfiguredSecretInput(authOverride?.token ?? cfg.gateway?.auth?.token, cfg.secrets?.defaults);
	const passwordConfigured = hasPassword || hasConfiguredSecretInput(authOverride?.password ?? cfg.gateway?.auth?.password, cfg.secrets?.defaults);
	const hasSharedSecret = resolvedAuthMode === "token" && tokenConfigured || resolvedAuthMode === "password" && passwordConfigured;
	const authHints = [];
	if (miskeys.hasGatewayToken) authHints.push("Found \"gateway.token\" in config. Use \"gateway.auth.token\" instead.");
	if (miskeys.hasRemoteToken) authHints.push("\"gateway.remote.token\" is for remote CLI calls; it does not enable local gateway auth.");
	if (resolvedAuthMode === "password" && !passwordConfigured) {
		defaultRuntime.error([
			"Gateway auth is set to password, but no password is configured.",
			"Set gateway.auth.password (or OPENCLAW_GATEWAY_PASSWORD), or pass --password.",
			...authHints
		].filter(Boolean).join("\n"));
		defaultRuntime.exit(EXIT_CONFIG_ERROR);
		return;
	}
	if (resolvedAuthMode === "none") gatewayLog.warn("Gateway auth mode=none explicitly configured; all gateway connections are unauthenticated.");
	const healthHost = await resolveGatewayBindHost(bind, cfg.gateway?.customBindHost);
	if (shouldBlockGatewayBindWithoutExplicitAuth({
		bindHost: healthHost,
		hasSharedSecret,
		resolvedAuthMode
	})) {
		defaultRuntime.error([
			`Refusing to bind gateway to ${bind} without auth.`,
			...isContainerEnvironment() ? ["Container environment detected — the gateway defaults to bind=auto (0.0.0.0) for port-forwarding compatibility.", "Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD, or pass --token/--password to start with auth."] : ["Set gateway.auth.token/password (or OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD) or pass --token/--password."],
			...authHints
		].filter(Boolean).join("\n"));
		defaultRuntime.exit(EXIT_CONFIG_ERROR);
		return;
	}
	const tailscaleOverride = tailscaleMode || opts.tailscaleResetOnExit ? {
		...tailscaleMode ? { mode: tailscaleMode } : {},
		...opts.tailscaleResetOnExit ? { resetOnExit: true } : {}
	} : void 0;
	gatewayLog.info("starting...");
	startupTrace.mark("cli.gateway-loop");
	let startupConfigSnapshotReadForNextStart = startupConfigSnapshotRead;
	const startLoop = async () => await runGatewayLoop({
		runtime: defaultRuntime,
		lockPort: port,
		healthHost,
		start: async ({ startupStartedAt } = {}) => {
			const startupConfigSnapshotReadForThisStart = startupConfigSnapshotReadForNextStart;
			startupConfigSnapshotReadForNextStart = void 0;
			return await startGatewayServer(port, {
				bind,
				auth: authOverride,
				tailscale: tailscaleOverride,
				startupStartedAt,
				...startupConfigSnapshotReadForThisStart ? { startupConfigSnapshotRead: startupConfigSnapshotReadForThisStart } : {}
			});
		}
	});
	const { detectRespawnSupervisor } = await import("./supervisor-markers-BvTtHkVE.js");
	const supervisor = detectRespawnSupervisor(process.env);
	try {
		await runGatewayLoopWithSupervisedLockRecovery({
			startLoop,
			supervisor,
			port,
			healthHost,
			log: gatewayLog
		});
	} catch (err) {
		if (isGatewayLockError(err)) {
			const errMessage = formatErrorMessage(err);
			defaultRuntime.error(`Gateway failed to start: ${errMessage}\nIf the gateway is supervised, stop it with: ${formatCliCommand("openclaw gateway stop")}`);
			try {
				const { formatPortDiagnostics, inspectPortUsage } = await import("./ports-OV6MUEXF.js");
				const diagnostics = await inspectPortUsage(port);
				if (diagnostics.status === "busy") for (const line of formatPortDiagnostics(diagnostics)) defaultRuntime.error(line);
			} catch {}
			const { maybeExplainGatewayServiceStop } = await import("./shared-DpjQDSkS.js");
			await maybeExplainGatewayServiceStop();
			defaultRuntime.exit(resolveGatewayLockErrorExitCode(err, supervisor));
			return;
		}
		await maybeWriteGatewayStartupFailureBundle(err);
		defaultRuntime.error(`Gateway failed to start: ${formatErrorMessage(err)}. Run ${formatCliCommand("openclaw gateway status --deep")} for diagnostics.`);
		defaultRuntime.exit(1);
	}
}
//#endregion
export { resolveGatewayRunOptions, runGatewayCommand };
