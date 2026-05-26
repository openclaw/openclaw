import { n as createTypingKeepaliveLoop, t as createTypingStartGuard } from "./typing-start-guard-BMWkR9l_.js";
//#region src/channels/typing.ts
function createTypingCallbacks(params) {
	const stop = params.stop;
	const keepaliveIntervalMs = params.keepaliveIntervalMs ?? 3e3;
	const maxConsecutiveFailures = Math.max(1, params.maxConsecutiveFailures ?? 2);
	const maxDurationMs = params.maxDurationMs ?? 6e4;
	let stopSent = false;
	let closed = false;
	let ttlTimer;
	const startGuard = createTypingStartGuard({
		isSealed: () => closed,
		onStartError: params.onStartError,
		maxConsecutiveFailures,
		onTrip: () => {
			keepaliveLoop.stop();
		}
	});
	const fireStart = async () => {
		await startGuard.run(() => params.start());
	};
	const keepaliveLoop = createTypingKeepaliveLoop({
		intervalMs: keepaliveIntervalMs,
		onTick: fireStart
	});
	const startTtlTimer = () => {
		if (maxDurationMs <= 0) return;
		clearTtlTimer();
		ttlTimer = setTimeout(() => {
			if (!closed) {
				console.warn(`[typing] TTL exceeded (${maxDurationMs}ms), auto-stopping typing indicator`);
				fireStop();
			}
		}, maxDurationMs);
	};
	const clearTtlTimer = () => {
		if (ttlTimer) {
			clearTimeout(ttlTimer);
			ttlTimer = void 0;
		}
	};
	const onReplyStart = async () => {
		if (closed) return;
		stopSent = false;
		startGuard.reset();
		keepaliveLoop.stop();
		clearTtlTimer();
		fireStart().then(() => {
			if (closed || startGuard.isTripped()) return;
			keepaliveLoop.start();
			startTtlTimer();
		});
		await Promise.resolve();
	};
	const fireStop = () => {
		closed = true;
		keepaliveLoop.stop();
		clearTtlTimer();
		if (!stop || stopSent) return;
		stopSent = true;
		stop().catch((err) => (params.onStopError ?? params.onStartError)(err));
	};
	return {
		onReplyStart,
		onIdle: fireStop,
		onCleanup: fireStop
	};
}
//#endregion
export { createTypingCallbacks as t };
