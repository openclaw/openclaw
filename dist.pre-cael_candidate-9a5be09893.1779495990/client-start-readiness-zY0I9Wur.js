import { n as resolveSafeTimeoutDelayMs } from "./timer-delay-awNPCchy.js";
import { t as resolveConnectChallengeTimeoutMs } from "./handshake-timeouts-DRUWxVZ0.js";
//#region src/gateway/event-loop-ready.ts
const DEFAULT_MAX_WAIT_MS = 1e4;
const DEFAULT_INTERVAL_MS = 1;
const DEFAULT_DRIFT_THRESHOLD_MS = 200;
const DEFAULT_CONSECUTIVE_READY_CHECKS = 2;
function resolvePositiveInteger(value, fallback) {
	return Number.isFinite(value) && value !== void 0 ? Math.max(1, Math.floor(value)) : fallback;
}
async function waitForEventLoopReady(options = {}) {
	const maxWaitMs = resolveSafeTimeoutDelayMs(options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
	const intervalMs = resolvePositiveInteger(options.intervalMs, DEFAULT_INTERVAL_MS);
	const driftThresholdMs = resolvePositiveInteger(options.driftThresholdMs, DEFAULT_DRIFT_THRESHOLD_MS);
	const consecutiveReadyChecks = resolvePositiveInteger(options.consecutiveReadyChecks, DEFAULT_CONSECUTIVE_READY_CHECKS);
	const signal = options.signal;
	const startedAt = Date.now();
	let readyChecks = 0;
	let checks = 0;
	let maxDriftMs = 0;
	return await new Promise((resolve) => {
		let settled = false;
		let timer = null;
		const clearTimer = () => {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		};
		const finish = (ready, aborted = false) => {
			if (settled) return;
			settled = true;
			clearTimer();
			signal?.removeEventListener("abort", onAbort);
			resolve({
				ready,
				elapsedMs: Math.max(0, Date.now() - startedAt),
				maxDriftMs,
				checks,
				aborted
			});
		};
		const onAbort = () => {
			finish(false, true);
		};
		if (signal?.aborted) {
			finish(false, true);
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		const scheduleNext = () => {
			if (signal?.aborted) {
				finish(false, true);
				return;
			}
			const remainingMs = maxWaitMs - Math.max(0, Date.now() - startedAt);
			if (remainingMs <= 0) {
				finish(false);
				return;
			}
			const delayMs = Math.min(intervalMs, remainingMs);
			const scheduledAt = Date.now();
			timer = setTimeout(() => {
				timer = null;
				checks += 1;
				const driftMs = Math.max(0, Date.now() - scheduledAt - delayMs);
				maxDriftMs = Math.max(maxDriftMs, driftMs);
				if (driftMs > driftThresholdMs) readyChecks = 0;
				else readyChecks += 1;
				if (readyChecks >= consecutiveReadyChecks) {
					finish(true);
					return;
				}
				scheduleNext();
			}, delayMs);
		};
		scheduleNext();
	});
}
//#endregion
//#region src/gateway/client-start-readiness.ts
function resolveGatewayClientStartReadinessTimeoutMs(options = {}) {
	if (typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)) return options.timeoutMs;
	const clientOptions = options.clientOptions ?? {};
	return resolveConnectChallengeTimeoutMs(typeof clientOptions.connectChallengeTimeoutMs === "number" && Number.isFinite(clientOptions.connectChallengeTimeoutMs) ? clientOptions.connectChallengeTimeoutMs : typeof clientOptions.connectDelayMs === "number" && Number.isFinite(clientOptions.connectDelayMs) ? clientOptions.connectDelayMs : void 0, { configuredTimeoutMs: clientOptions.preauthHandshakeTimeoutMs });
}
async function startGatewayClientWhenEventLoopReady(client, options = {}) {
	const readiness = await waitForEventLoopReady({
		maxWaitMs: resolveGatewayClientStartReadinessTimeoutMs(options),
		signal: options.signal
	});
	if (readiness.ready && !readiness.aborted && options.signal?.aborted !== true) client.start();
	return readiness;
}
//#endregion
export { startGatewayClientWhenEventLoopReady as t };
