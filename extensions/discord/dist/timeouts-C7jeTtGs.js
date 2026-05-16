//#region extensions/discord/src/monitor/timeouts.ts
const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 12e4;
const DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS = 30 * 6e4;
const DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS = 6e4;
const DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS = 12e4;
function mergeAbortSignals(signals) {
	const activeSignals = signals.filter((signal) => Boolean(signal));
	if (activeSignals.length === 0) return;
	if (activeSignals.length === 1) return activeSignals[0];
	if (typeof AbortSignal.any === "function") return AbortSignal.any(activeSignals);
	const fallbackController = new AbortController();
	for (const signal of activeSignals) if (signal.aborted) {
		fallbackController.abort();
		return fallbackController.signal;
	}
	const abortFallback = () => {
		fallbackController.abort();
		for (const signal of activeSignals) signal.removeEventListener("abort", abortFallback);
	};
	for (const signal of activeSignals) signal.addEventListener("abort", abortFallback, { once: true });
	return fallbackController.signal;
}
async function raceWithTimeout(params) {
	let timeoutTimer;
	const timeoutPromise = new Promise((resolve) => {
		timeoutTimer = setTimeout(() => resolve(params.onTimeout()), Math.max(1, params.timeoutMs));
		timeoutTimer.unref?.();
	});
	try {
		return await Promise.race([params.promise, timeoutPromise]);
	} finally {
		if (timeoutTimer) clearTimeout(timeoutTimer);
	}
}
async function withAbortTimeout(params) {
	const controller = new AbortController();
	let timeoutTimer;
	const timeoutPromise = new Promise((_, reject) => {
		timeoutTimer = setTimeout(() => {
			controller.abort();
			reject(params.createTimeoutError());
		}, Math.max(1, params.timeoutMs));
		timeoutTimer.unref?.();
	});
	try {
		return await Promise.race([params.run(controller.signal), timeoutPromise]);
	} finally {
		if (timeoutTimer) clearTimeout(timeoutTimer);
	}
}
//#endregion
export { mergeAbortSignals as a, DISCORD_DEFAULT_LISTENER_TIMEOUT_MS as i, DISCORD_ATTACHMENT_TOTAL_TIMEOUT_MS as n, raceWithTimeout as o, DISCORD_DEFAULT_INBOUND_WORKER_TIMEOUT_MS as r, withAbortTimeout as s, DISCORD_ATTACHMENT_IDLE_TIMEOUT_MS as t };
