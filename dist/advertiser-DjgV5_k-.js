import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { t as collectErrorGraphCandidates } from "./errors-b3ZrCRlt.js";
import "./error-runtime-DGHc7DZw.js";
import "./runtime-env-BtvWnLRh.js";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
//#region extensions/bonjour/src/errors.ts
function formatBonjourError(err) {
	if (err instanceof Error) {
		const msg = err.message.trim() || err.name || String(err).trim();
		if (err.name && err.name !== "Error") return msg === err.name ? err.name : `${err.name}: ${msg}`;
		return msg;
	}
	return String(err);
}
//#endregion
//#region extensions/bonjour/src/ciao.ts
const CIAO_CANCELLATION_MESSAGE_RE = /^CIAO (?:ANNOUNCEMENT|PROBING) CANCELLED\b/u;
const CIAO_INTERFACE_ASSERTION_MESSAGE_RE = /REACHED ILLEGAL STATE!?\s+IPV4 ADDRESS CHANGED? FROM (?:DEFINED TO UNDEFINED|UNDEFINED TO DEFINED)!?/u;
const CIAO_NETMASK_ASSERTION_MESSAGE_RE = /IP ADDRESS VERSION MUST MATCH\.\s+NETMASK CANNOT HAVE A VERSION DIFFERENT FROM THE ADDRESS!?/u;
const CIAO_SELF_PROBE_MESSAGE_RE = /CAN'T PROBE FOR A SERVICE WHICH IS ANNOUNCED ALREADY\.\s+RECEIVED (?:PROBING|ANNOUNCING|ANNOUNCED) FOR SERVICE\b/u;
const CIAO_INTERFACE_ENUMERATION_FAILURE_RE = /\bUV_INTERFACE_ADDRESSES\b/u;
function classifyCiaoProcessError(reason) {
	for (const candidate of collectErrorGraphCandidates(reason, (current) => [
		current.cause,
		current.reason,
		current.original,
		current.error,
		current.data,
		...Array.isArray(current.errors) ? current.errors : []
	])) {
		const formatted = formatBonjourError(candidate);
		const message = formatted.toUpperCase();
		if (CIAO_CANCELLATION_MESSAGE_RE.test(message)) return {
			kind: "cancellation",
			formatted
		};
		if (CIAO_INTERFACE_ASSERTION_MESSAGE_RE.test(message)) return {
			kind: "interface-assertion",
			formatted
		};
		if (CIAO_NETMASK_ASSERTION_MESSAGE_RE.test(message)) return {
			kind: "netmask-assertion",
			formatted
		};
		if (CIAO_SELF_PROBE_MESSAGE_RE.test(message)) return {
			kind: "self-probe",
			formatted
		};
		if (CIAO_INTERFACE_ENUMERATION_FAILURE_RE.test(message)) return {
			kind: "interface-enumeration-failure",
			formatted
		};
	}
	return null;
}
//#endregion
//#region extensions/bonjour/src/advertiser.ts
const childProcessModule = createRequire(import.meta.url)("node:child_process");
const WATCHDOG_INTERVAL_MS = 5e3;
const REPAIR_DEBOUNCE_MS = 3e4;
const CONFLICT_SETTLE_MS = 3e4;
const STUCK_ANNOUNCING_MS = 2e4;
const MAX_CONSECUTIVE_RESTARTS = 3;
const MAX_CONSECUTIVE_STUCK_STATE_RESTARTS = 1;
const RESTART_WINDOW_MS = 30 * 6e4;
const MAX_RESTARTS_IN_WINDOW = 5;
const BONJOUR_ANNOUNCED_STATE = "announced";
const CIAO_SELF_PROBE_RETRY_FRAGMENT = "failed probing with reason: Error: Can't probe for a service which is announced already.";
const defaultLogger = {
	info: (_msg) => {},
	warn: (_msg) => {},
	debug: (_msg) => {}
};
const CIAO_MODULE_ID = "@homebridge/ciao";
const CIAO_WINDOWS_SHELL_COMMANDS = new Set(["arp -a | findstr /C:\"---\""]);
let ciaoModulePromise = null;
let ciaoExecHidePatchDepth = 0;
let restoreCiaoExecHidePatchOnce = null;
async function loadCiaoModule() {
	ciaoModulePromise ??= import(CIAO_MODULE_ID);
	return ciaoModulePromise;
}
function readBonjourDisableOverride() {
	const raw = process.env.OPENCLAW_DISABLE_BONJOUR;
	const normalized = raw?.trim().toLowerCase();
	if (!normalized) return null;
	if (isTruthyEnvValue(raw)) return true;
	switch (normalized) {
		case "0":
		case "false":
		case "no":
		case "off": return false;
		default: return null;
	}
}
function isContainerEnvironment() {
	if (process.env.FLY_MACHINE_ID?.trim() && process.env.FLY_APP_NAME?.trim()) return true;
	for (const sentinelPath of [
		"/.dockerenv",
		"/run/.containerenv",
		"/var/run/.containerenv"
	]) try {
		if (fs.existsSync(sentinelPath)) return true;
	} catch {}
	try {
		const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
		return /\/docker\/|cri-containerd-[0-9a-f]|containerd\/[0-9a-f]{64}|\/kubepods[/.]|\blxc\b/u.test(cgroup);
	} catch {
		return false;
	}
}
function isDisabledByEnv() {
	if (process.env.VITEST) return true;
	const envOverride = readBonjourDisableOverride();
	if (envOverride !== null) return envOverride;
	if (isContainerEnvironment()) return true;
	return false;
}
function resolveSystemMdnsHostname() {
	let raw;
	try {
		raw = os.hostname();
	} catch {
		return null;
	}
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const firstLabel = trimmed.replace(/\.local$/i, "").split(".")[0]?.trim() ?? "";
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(firstLabel)) return null;
	return firstLabel;
}
const MAX_DNS_LABEL_BYTES = 63;
const utf8Encoder = new TextEncoder();
function truncateToDnsLabel(name, fallback = "OpenClaw") {
	const encoded = utf8Encoder.encode(name);
	if (encoded.byteLength <= MAX_DNS_LABEL_BYTES) return name;
	for (let end = MAX_DNS_LABEL_BYTES; end > 0; end -= 1) try {
		return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end)).replace(/-+$/, "").trim() || fallback;
	} catch {}
	return fallback;
}
function safeServiceName(name) {
	const trimmed = name.trim();
	return trimmed.length > 0 ? truncateToDnsLabel(trimmed) : "OpenClaw";
}
function prettifyInstanceName(name) {
	const normalized = name.trim().replace(/\s+/g, " ");
	return normalized.replace(/\s+\(OpenClaw\)\s*$/i, "").trim() || normalized;
}
function serviceSummary(label, svc) {
	let fqdn = "unknown";
	let hostname = "unknown";
	let port = -1;
	try {
		fqdn = svc.getFQDN();
	} catch {}
	try {
		hostname = svc.getHostname();
	} catch {}
	try {
		port = svc.getPort();
	} catch {}
	const state = typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
	return `${label} fqdn=${fqdn} host=${hostname} port=${port} state=${state}`;
}
function isAnnouncedState(state) {
	return state === BONJOUR_ANNOUNCED_STATE;
}
function isAdvertisingInProgressState(state) {
	return state === "probing" || state === "announcing";
}
function shouldSuppressCiaoConsoleLog(args) {
	return args.some((arg) => typeof arg === "string" && arg.includes(CIAO_SELF_PROBE_RETRY_FRAGMENT));
}
function installCiaoConsoleNoiseFilter() {
	const previousConsoleLog = console.log;
	const wrapper = ((...args) => {
		if (shouldSuppressCiaoConsoleLog(args)) return;
		previousConsoleLog(...args);
	});
	console.log = wrapper;
	return () => {
		if (console.log === wrapper) console.log = previousConsoleLog;
	};
}
function isExecOptionsRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function shouldHideCiaoWindowsShell(command) {
	return process.platform === "win32" && CIAO_WINDOWS_SHELL_COMMANDS.has(command.trim());
}
function installCiaoWindowsExecHidePatch() {
	if (process.platform !== "win32") return () => {};
	ciaoExecHidePatchDepth += 1;
	if (!restoreCiaoExecHidePatchOnce) {
		const previousExec = childProcessModule.exec;
		const wrapper = ((command, options, callback) => {
			if (shouldHideCiaoWindowsShell(command)) {
				if (typeof options === "function") return previousExec.call(childProcessModule, command, { windowsHide: true }, options);
				if (options == null) return previousExec.call(childProcessModule, command, { windowsHide: true }, callback);
				if (isExecOptionsRecord(options) && options.windowsHide === void 0) return previousExec.call(childProcessModule, command, {
					...options,
					windowsHide: true
				}, callback);
			}
			return previousExec.call(childProcessModule, command, options, callback);
		});
		childProcessModule.exec = wrapper;
		restoreCiaoExecHidePatchOnce = () => {
			if (childProcessModule.exec === wrapper) childProcessModule.exec = previousExec;
		};
	}
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		ciaoExecHidePatchDepth = Math.max(0, ciaoExecHidePatchDepth - 1);
		if (ciaoExecHidePatchDepth > 0) return;
		restoreCiaoExecHidePatchOnce?.();
		restoreCiaoExecHidePatchOnce = null;
	};
}
function installCiaoUnhandledRejectionListener(handler) {
	const hadOtherListeners = process.listenerCount("unhandledRejection") > 0;
	const listener = (reason) => {
		if (handler(reason)) return;
		if (hadOtherListeners) return;
		queueMicrotask(() => {
			throw reason instanceof Error ? reason : new Error(String(reason));
		});
	};
	process.on("unhandledRejection", listener);
	return () => {
		process.off("unhandledRejection", listener);
	};
}
async function startGatewayBonjourAdvertiser(opts, deps = {}) {
	if (isDisabledByEnv()) return { stop: async () => {} };
	const logger = {
		info: deps.logger?.info ?? defaultLogger.info,
		warn: deps.logger?.warn ?? defaultLogger.warn,
		debug: deps.logger?.debug ?? defaultLogger.debug
	};
	const restoreCiaoExecHidePatch = installCiaoWindowsExecHidePatch();
	let restoreConsoleLog = () => {};
	let requestCiaoRecovery;
	let cleanupUnhandledRejection;
	let cleanupDirectUnhandledRejection;
	let cleanupUncaughtException;
	let processHandlersCleaned = false;
	function cleanupProcessHandlers() {
		if (processHandlersCleaned) return;
		processHandlersCleaned = true;
		cleanupDirectUnhandledRejection?.();
		cleanupUncaughtException?.();
		cleanupUnhandledRejection?.();
	}
	try {
		const { getResponder, Protocol } = await loadCiaoModule();
		restoreConsoleLog = installCiaoConsoleNoiseFilter();
		const handleCiaoProcessError = (reason) => {
			const classification = classifyCiaoProcessError(reason);
			if (!classification) return false;
			if (classification.kind === "cancellation") {
				logger.warn(`bonjour: suppressing ciao cancellation: ${classification.formatted}`);
				requestCiaoRecovery?.(classification);
			} else if (classification.kind === "interface-enumeration-failure") logger.warn(`bonjour: disabling mDNS — networkInterfaces() unavailable in this environment: ${classification.formatted}`);
			else {
				const label = classification.kind === "netmask-assertion" ? "netmask assertion" : classification.kind === "self-probe" ? "self-probe race" : "interface assertion";
				logger.warn(`bonjour: suppressing ciao ${label}: ${classification.formatted}`);
				requestCiaoRecovery?.(classification);
			}
			return true;
		};
		cleanupDirectUnhandledRejection = installCiaoUnhandledRejectionListener(handleCiaoProcessError);
		cleanupUnhandledRejection = deps.registerUnhandledRejectionHandler?.(handleCiaoProcessError);
		cleanupUncaughtException = deps.registerUncaughtExceptionHandler?.(handleCiaoProcessError);
		const hostname = truncateToDnsLabel((process.env.OPENCLAW_MDNS_HOSTNAME?.trim() || resolveSystemMdnsHostname() || "openclaw").replace(/\.local$/i, "").split(".")[0].trim() || "openclaw", "openclaw");
		const instanceName = typeof opts.instanceName === "string" && opts.instanceName.trim() ? opts.instanceName.trim() : `${hostname} (OpenClaw)`;
		const displayName = prettifyInstanceName(instanceName);
		const txtBase = {
			role: "gateway",
			gatewayPort: String(opts.gatewayPort),
			lanHost: `${hostname}.local`,
			displayName
		};
		if (opts.gatewayTlsEnabled) {
			txtBase.gatewayTls = "1";
			if (opts.gatewayTlsFingerprintSha256) txtBase.gatewayTlsSha256 = opts.gatewayTlsFingerprintSha256;
		}
		if (opts.gatewayDirectReachable) txtBase.gatewayDirectReachable = "1";
		if (typeof opts.canvasPort === "number" && opts.canvasPort > 0) txtBase.canvasPort = String(opts.canvasPort);
		if (!opts.minimal && typeof opts.tailnetDns === "string" && opts.tailnetDns.trim()) txtBase.tailnetDns = opts.tailnetDns.trim();
		if (!opts.minimal && typeof opts.cliPath === "string" && opts.cliPath.trim()) txtBase.cliPath = opts.cliPath.trim();
		const gatewayTxt = {
			...txtBase,
			transport: "gateway"
		};
		if (!opts.minimal) gatewayTxt.sshPort = String(opts.sshPort ?? 22);
		const responder = getResponder();
		function createCycle() {
			const services = [];
			const gateway = responder.createService({
				name: safeServiceName(instanceName),
				type: "openclaw-gw",
				protocol: Protocol.TCP,
				port: opts.gatewayPort,
				domain: "local",
				hostname,
				txt: gatewayTxt
			});
			services.push({
				label: "gateway",
				svc: gateway
			});
			return {
				responder,
				services
			};
		}
		async function stopCycle(cycle, opts) {
			if (!cycle) return;
			for (const { svc } of cycle.services) try {
				await svc.destroy();
			} catch {}
			try {
				if (opts?.shutdownResponder) await cycle.responder.shutdown();
			} catch {}
		}
		function attachConflictListeners(services) {
			for (const { label, svc } of services) try {
				svc.on("name-change", (name) => {
					markConflictObserved(label, svc);
					const next = typeof name === "string" ? name : String(name);
					logger.warn(`bonjour: ${label} name conflict resolved; newName=${JSON.stringify(next)}`);
				});
				svc.on("hostname-change", (nextHostname) => {
					markConflictObserved(label, svc);
					const next = typeof nextHostname === "string" ? nextHostname : String(nextHostname);
					logger.warn(`bonjour: ${label} hostname conflict resolved; newHostname=${JSON.stringify(next)}`);
				});
			} catch (err) {
				logger.debug(`bonjour: failed to attach listeners for ${label}: ${String(err)}`);
			}
		}
		function handleAdvertiseFailure(label, svc, err, action) {
			const classification = classifyCiaoProcessError(err);
			if (classification) {
				logger.warn(`bonjour: advertise ${action} with ciao ${classification.kind} (${serviceSummary(label, svc)}): ${classification.formatted}`);
				requestCiaoRecovery?.(classification);
				return;
			}
			logger.warn(`bonjour: advertise ${action} (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`);
		}
		function startAdvertising(services) {
			for (const { label, svc } of services) try {
				svc.advertise().then(() => {
					logger.info(`bonjour: advertised ${serviceSummary(label, svc)}`);
				}).catch((err) => {
					handleAdvertiseFailure(label, svc, err, "failed");
				});
			} catch (err) {
				handleAdvertiseFailure(label, svc, err, "threw");
			}
		}
		logger.debug(`bonjour: starting (hostname=${hostname}, instance=${JSON.stringify(safeServiceName(instanceName))}, gatewayPort=${opts.gatewayPort}${opts.minimal ? ", minimal=true" : `, sshPort=${opts.sshPort ?? 22}`})`);
		let stopped = false;
		let recreatePromise = null;
		let disabled = false;
		let consecutiveRestarts = 0;
		let consecutiveStuckStateRestarts = 0;
		const restartTimestamps = [];
		let cycle = createCycle();
		const stateTracker = /* @__PURE__ */ new Map();
		const conflictTracker = /* @__PURE__ */ new Map();
		const markConflictObserved = (label, svc) => {
			const now = Date.now();
			conflictTracker.set(label, now);
			const nextState = typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
			stateTracker.set(label, {
				state: nextState,
				sinceMs: now
			});
		};
		const updateStateTrackers = (services) => {
			const now = Date.now();
			for (const { label, svc } of services) {
				const nextState = typeof svc.serviceState === "string" ? svc.serviceState : "unknown";
				const current = stateTracker.get(label);
				const nextEnteredAt = current && !isAnnouncedState(current.state) && !isAnnouncedState(nextState) ? current.sinceMs : now;
				if (!current || current.state !== nextState || current.sinceMs !== nextEnteredAt) stateTracker.set(label, {
					state: nextState,
					sinceMs: nextEnteredAt
				});
			}
		};
		const recreateAdvertiser = async (reason, opts) => {
			if (stopped || disabled) return;
			if (recreatePromise) return recreatePromise;
			recreatePromise = (async () => {
				consecutiveRestarts += 1;
				consecutiveStuckStateRestarts = opts?.stuckState ? consecutiveStuckStateRestarts + 1 : 0;
				const now = Date.now();
				while (restartTimestamps.length > 0 && now - (restartTimestamps[0] ?? 0) > RESTART_WINDOW_MS) restartTimestamps.shift();
				restartTimestamps.push(now);
				const tooManyConsecutive = consecutiveRestarts > MAX_CONSECUTIVE_RESTARTS;
				const tooManyStuckStates = consecutiveStuckStateRestarts > MAX_CONSECUTIVE_STUCK_STATE_RESTARTS;
				const tooManyInWindow = restartTimestamps.length >= MAX_RESTARTS_IN_WINDOW;
				if (tooManyConsecutive || tooManyStuckStates || tooManyInWindow) {
					disabled = true;
					const detail = tooManyConsecutive ? `${MAX_CONSECUTIVE_RESTARTS} failed restarts` : tooManyStuckStates ? `${MAX_CONSECUTIVE_STUCK_STATE_RESTARTS} stuck-state restart` : `${MAX_RESTARTS_IN_WINDOW} restarts within ${Math.round(RESTART_WINDOW_MS / 6e4)} minutes`;
					logger.warn(`bonjour: disabling advertiser after ${detail} (${reason}); set discovery.mdns.mode="off" or OPENCLAW_DISABLE_BONJOUR=1 to disable mDNS discovery`);
					const previous = cycle;
					cycle = null;
					stateTracker.clear();
					conflictTracker.clear();
					await stopCycle(previous, { shutdownResponder: true });
					restoreConsoleLog();
					restoreCiaoExecHidePatch();
					return;
				}
				logger.warn(`bonjour: restarting advertiser (${reason})`);
				await stopCycle(cycle);
				cycle = createCycle();
				stateTracker.clear();
				conflictTracker.clear();
				attachConflictListeners(cycle.services);
				startAdvertising(cycle.services);
			})().finally(() => {
				recreatePromise = null;
			});
			return recreatePromise;
		};
		requestCiaoRecovery = (classification) => {
			recreateAdvertiser(`ciao ${classification.kind}: ${classification.formatted}`);
		};
		attachConflictListeners(cycle.services);
		startAdvertising(cycle.services);
		const lastRepairAttempt = /* @__PURE__ */ new Map();
		const watchdog = setInterval(() => {
			if (stopped || recreatePromise) return;
			if (disabled || !cycle) return;
			updateStateTrackers(cycle.services);
			for (const { label, svc } of cycle.services) {
				const now = Date.now();
				const stateUnknown = svc.serviceState;
				if (typeof stateUnknown !== "string") continue;
				if (stateUnknown === "announced") {
					consecutiveRestarts = 0;
					consecutiveStuckStateRestarts = 0;
					conflictTracker.delete(label);
				}
				const lastConflictAt = conflictTracker.get(label);
				if (lastConflictAt !== void 0 && now - lastConflictAt >= CONFLICT_SETTLE_MS) conflictTracker.delete(label);
				if (lastConflictAt !== void 0 && now - lastConflictAt < CONFLICT_SETTLE_MS) continue;
				const tracked = stateTracker.get(label);
				if (stateUnknown !== "announced" && tracked && now - tracked.sinceMs >= STUCK_ANNOUNCING_MS) {
					recreateAdvertiser(`service stuck in ${stateUnknown} for ${now - tracked.sinceMs}ms (${serviceSummary(label, svc)})`, { stuckState: true });
					return;
				}
				if (stateUnknown === "announced" || isAdvertisingInProgressState(stateUnknown)) continue;
				let key = label;
				try {
					key = `${label}:${svc.getFQDN()}`;
				} catch {}
				if (now - (lastRepairAttempt.get(key) ?? 0) < REPAIR_DEBOUNCE_MS) continue;
				lastRepairAttempt.set(key, now);
				logger.warn(`bonjour: watchdog detected non-announced service; attempting re-advertise (${serviceSummary(label, svc)})`);
				try {
					svc.advertise().catch((err) => {
						logger.warn(`bonjour: watchdog re-advertise failed (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`);
					});
				} catch (err) {
					logger.warn(`bonjour: watchdog re-advertise threw (${serviceSummary(label, svc)}): ${formatBonjourError(err)}`);
				}
			}
		}, WATCHDOG_INTERVAL_MS);
		watchdog.unref?.();
		return { stop: async () => {
			stopped = true;
			clearInterval(watchdog);
			try {
				await recreatePromise;
			} catch {}
			await stopCycle(cycle, { shutdownResponder: true });
			restoreConsoleLog();
			restoreCiaoExecHidePatch();
			cleanupProcessHandlers();
		} };
	} catch (err) {
		restoreConsoleLog();
		restoreCiaoExecHidePatch();
		cleanupProcessHandlers();
		throw err;
	}
}
//#endregion
export { startGatewayBonjourAdvertiser };
