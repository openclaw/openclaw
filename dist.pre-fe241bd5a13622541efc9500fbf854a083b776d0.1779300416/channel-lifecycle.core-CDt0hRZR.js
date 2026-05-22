import { t as KeyedAsyncQueue } from "./keyed-async-queue-CBv-Vhmc.js";
//#region src/channels/run-state-machine.ts
const DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS = 6e4;
function createRunStateMachine(params) {
	const heartbeatMs = params.heartbeatMs ?? DEFAULT_RUN_ACTIVITY_HEARTBEAT_MS;
	const now = params.now ?? Date.now;
	let activeRuns = 0;
	let runActivityHeartbeat = null;
	let lifecycleActive = !params.abortSignal?.aborted;
	const publish = () => {
		if (!lifecycleActive) return;
		params.setStatus?.({
			activeRuns,
			busy: activeRuns > 0,
			lastRunActivityAt: now()
		});
	};
	const clearHeartbeat = () => {
		if (!runActivityHeartbeat) return;
		clearInterval(runActivityHeartbeat);
		runActivityHeartbeat = null;
	};
	const ensureHeartbeat = () => {
		if (runActivityHeartbeat || activeRuns <= 0 || !lifecycleActive) return;
		runActivityHeartbeat = setInterval(() => {
			if (!lifecycleActive || activeRuns <= 0) {
				clearHeartbeat();
				return;
			}
			publish();
		}, heartbeatMs);
		runActivityHeartbeat.unref?.();
	};
	const deactivate = () => {
		lifecycleActive = false;
		clearHeartbeat();
	};
	const onAbort = () => {
		deactivate();
	};
	if (params.abortSignal?.aborted) onAbort();
	else params.abortSignal?.addEventListener("abort", onAbort, { once: true });
	if (lifecycleActive) params.setStatus?.({
		activeRuns: 0,
		busy: false
	});
	return {
		isActive() {
			return lifecycleActive;
		},
		onRunStart() {
			activeRuns += 1;
			publish();
			ensureHeartbeat();
		},
		onRunEnd() {
			activeRuns = Math.max(0, activeRuns - 1);
			if (activeRuns <= 0) clearHeartbeat();
			publish();
		},
		deactivate
	};
}
//#endregion
//#region src/plugin-sdk/channel-lifecycle.core.ts
/** Bind a fixed account id into a status writer so lifecycle code can emit partial snapshots. */
function createAccountStatusSink(params) {
	return (patch) => {
		params.setStatus({
			accountId: params.accountId,
			...patch
		});
	};
}
/**
* Serialize channel work per key while keeping lifecycle/busy accounting out of
* channel-specific message handlers. The queue does not impose run timeouts;
* callers should rely on session/tool/runtime lifecycle for long-running work.
*/
function createChannelRunQueue(params) {
	const queue = new KeyedAsyncQueue();
	const runState = createRunStateMachine({
		setStatus: params.setStatus,
		abortSignal: params.abortSignal
	});
	const reportError = (error) => {
		try {
			params.onError?.(error);
		} catch {}
	};
	return {
		enqueue(key, task) {
			queue.enqueue(key, async () => {
				if (!runState.isActive()) return;
				runState.onRunStart();
				try {
					if (!runState.isActive()) return;
					await task({ lifecycleSignal: params.abortSignal });
				} finally {
					runState.onRunEnd();
				}
			}).catch(reportError);
		},
		deactivate: runState.deactivate
	};
}
/**
* Return a promise that resolves when the signal is aborted.
*
* If no signal is provided, the promise stays pending forever. When provided,
* `onAbort` runs once before the promise resolves.
*/
function waitUntilAbort(signal, onAbort) {
	return new Promise((resolve, reject) => {
		const complete = () => {
			Promise.resolve(onAbort?.()).then(() => resolve(), reject);
		};
		if (!signal) return;
		if (signal.aborted) {
			complete();
			return;
		}
		signal.addEventListener("abort", complete, { once: true });
	});
}
/**
* Keep a passive account task alive until abort, then run optional cleanup.
*/
async function runPassiveAccountLifecycle(params) {
	const handle = await params.start();
	try {
		await waitUntilAbort(params.abortSignal);
	} finally {
		await params.stop?.(handle);
		await params.onStop?.();
	}
}
/**
* Keep a channel/provider task pending until the HTTP server closes.
*
* When an abort signal is provided, `onAbort` is invoked once and should
* trigger server shutdown. The returned promise resolves only after `close`.
*/
async function keepHttpServerTaskAlive(params) {
	const { server, abortSignal, onAbort } = params;
	let abortTask = Promise.resolve();
	let abortTriggered = false;
	const triggerAbort = () => {
		if (abortTriggered) return;
		abortTriggered = true;
		abortTask = Promise.resolve(onAbort?.()).then(() => void 0);
	};
	const onAbortSignal = () => {
		triggerAbort();
	};
	if (abortSignal) if (abortSignal.aborted) triggerAbort();
	else abortSignal.addEventListener("abort", onAbortSignal, { once: true });
	await new Promise((resolve) => {
		server.once("close", () => resolve());
	});
	if (abortSignal) abortSignal.removeEventListener("abort", onAbortSignal);
	await abortTask;
}
//#endregion
export { waitUntilAbort as a, runPassiveAccountLifecycle as i, createChannelRunQueue as n, createRunStateMachine as o, keepHttpServerTaskAlive as r, createAccountStatusSink as t };
