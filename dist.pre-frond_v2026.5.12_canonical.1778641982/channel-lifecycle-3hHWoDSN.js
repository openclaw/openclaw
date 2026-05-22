import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
//#region src/channels/draft-preview-finalizer.ts
async function deliverFinalizableDraftPreview(params) {
	if (params.kind !== "final" || !params.draft) {
		if (await params.deliverNormally(params.payload) === false) return "normal-skipped";
		await params.onNormalDelivered?.();
		return "normal-delivered";
	}
	const edit = params.buildFinalEdit(params.payload);
	if (edit !== void 0) {
		await params.draft.flush();
		const previewId = params.draft.id();
		if (previewId !== void 0) {
			await params.draft.seal?.();
			try {
				await params.editFinal(previewId, edit);
				await params.onPreviewFinalized?.(previewId);
				return "preview-finalized";
			} catch (err) {
				params.logPreviewEditFailure?.(err);
			}
		}
	}
	if (params.draft.discardPending) await params.draft.discardPending();
	else await params.draft.clear();
	let delivered = false;
	try {
		delivered = await params.deliverNormally(params.payload) !== false;
		if (delivered) await params.onNormalDelivered?.();
	} finally {
		if (delivered) await params.draft.clear();
	}
	return delivered ? "normal-delivered" : "normal-skipped";
}
//#endregion
//#region src/channels/draft-stream-loop.ts
function createDraftStreamLoop(params) {
	let lastSentAt = 0;
	let pendingText = "";
	let inFlightPromise;
	let timer;
	const flush = async () => {
		if (timer) {
			clearTimeout(timer);
			timer = void 0;
		}
		while (!params.isStopped()) {
			if (inFlightPromise) {
				await inFlightPromise;
				continue;
			}
			const text = pendingText;
			if (!text.trim()) {
				pendingText = "";
				return;
			}
			pendingText = "";
			const current = params.sendOrEditStreamMessage(text).finally(() => {
				if (inFlightPromise === current) inFlightPromise = void 0;
			});
			inFlightPromise = current;
			if (await current === false) {
				pendingText = text;
				return;
			}
			lastSentAt = Date.now();
			if (!pendingText) return;
		}
	};
	const schedule = () => {
		if (timer) return;
		const delay = Math.max(0, params.throttleMs - (Date.now() - lastSentAt));
		timer = setTimeout(() => {
			flush();
		}, delay);
	};
	return {
		update: (text) => {
			if (params.isStopped()) return;
			pendingText = text;
			if (inFlightPromise) {
				schedule();
				return;
			}
			if (!timer && Date.now() - lastSentAt >= params.throttleMs) {
				flush();
				return;
			}
			schedule();
		},
		flush,
		stop: () => {
			pendingText = "";
			if (timer) {
				clearTimeout(timer);
				timer = void 0;
			}
		},
		resetPending: () => {
			pendingText = "";
		},
		resetThrottleWindow: () => {
			lastSentAt = 0;
			if (timer) {
				clearTimeout(timer);
				timer = void 0;
			}
		},
		waitForInFlight: async () => {
			if (inFlightPromise) await inFlightPromise;
		}
	};
}
//#endregion
//#region src/channels/draft-stream-controls.ts
function createFinalizableDraftStreamControls(params) {
	const loop = createDraftStreamLoop({
		throttleMs: params.throttleMs,
		isStopped: params.isStopped,
		sendOrEditStreamMessage: params.sendOrEditStreamMessage
	});
	const update = (text) => {
		if (params.isStopped() || params.isFinal()) return;
		loop.update(text);
	};
	const stop = async () => {
		params.markFinal();
		await loop.flush();
	};
	const stopForClear = async () => {
		params.markStopped();
		loop.stop();
		await loop.waitForInFlight();
	};
	const seal = async () => {
		params.markFinal();
		loop.stop();
		await loop.waitForInFlight();
	};
	return {
		loop,
		update,
		stop,
		seal,
		discardPending: stopForClear,
		stopForClear
	};
}
function createFinalizableDraftStreamControlsForState(params) {
	return createFinalizableDraftStreamControls({
		throttleMs: params.throttleMs,
		isStopped: () => params.state.stopped,
		isFinal: () => params.state.final,
		markStopped: () => {
			params.state.stopped = true;
		},
		markFinal: () => {
			params.state.final = true;
		},
		sendOrEditStreamMessage: params.sendOrEditStreamMessage
	});
}
async function takeMessageIdAfterStop(params) {
	await params.stopForClear();
	const messageId = params.readMessageId();
	params.clearMessageId();
	return messageId;
}
async function clearFinalizableDraftMessage(params) {
	const messageId = await takeMessageIdAfterStop({
		stopForClear: params.stopForClear,
		readMessageId: params.readMessageId,
		clearMessageId: params.clearMessageId
	});
	if (!params.isValidMessageId(messageId)) return;
	try {
		await params.deleteMessage(messageId);
		params.onDeleteSuccess?.(messageId);
	} catch (err) {
		params.warn?.(`${params.warnPrefix}: ${formatErrorMessage(err)}`);
	}
}
function createFinalizableDraftLifecycle(params) {
	const controls = createFinalizableDraftStreamControlsForState({
		throttleMs: params.throttleMs,
		state: params.state,
		sendOrEditStreamMessage: params.sendOrEditStreamMessage
	});
	const clear = async () => {
		await clearFinalizableDraftMessage({
			stopForClear: controls.stopForClear,
			readMessageId: params.readMessageId,
			clearMessageId: params.clearMessageId,
			isValidMessageId: params.isValidMessageId,
			deleteMessage: params.deleteMessage,
			onDeleteSuccess: params.onDeleteSuccess,
			warn: params.warn,
			warnPrefix: params.warnPrefix
		});
	};
	return {
		...controls,
		clear
	};
}
//#endregion
//#region src/channels/transport/stall-watchdog.ts
function createArmableStallWatchdog(params) {
	const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
	const checkIntervalMs = Math.max(100, Math.floor(params.checkIntervalMs ?? Math.min(5e3, Math.max(250, timeoutMs / 6))));
	let armed = false;
	let stopped = false;
	let lastActivityAt = Date.now();
	let timer = null;
	const clearTimer = () => {
		if (!timer) return;
		clearInterval(timer);
		timer = null;
	};
	const disarm = () => {
		armed = false;
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		disarm();
		clearTimer();
		params.abortSignal?.removeEventListener("abort", stop);
	};
	const arm = (atMs) => {
		if (stopped) return;
		lastActivityAt = atMs ?? Date.now();
		armed = true;
	};
	const touch = (atMs) => {
		if (stopped) return;
		lastActivityAt = atMs ?? Date.now();
	};
	const check = () => {
		if (!armed || stopped) return;
		const idleMs = Date.now() - lastActivityAt;
		if (idleMs < timeoutMs) return;
		disarm();
		params.runtime?.error?.(`[${params.label}] transport watchdog timeout: idle ${Math.round(idleMs / 1e3)}s (limit ${Math.round(timeoutMs / 1e3)}s)`);
		params.onTimeout({
			idleMs,
			timeoutMs
		});
	};
	if (params.abortSignal?.aborted) stop();
	else {
		params.abortSignal?.addEventListener("abort", stop, { once: true });
		timer = setInterval(check, checkIntervalMs);
		timer.unref?.();
	}
	return {
		arm,
		touch,
		disarm,
		stop,
		isArmed: () => armed
	};
}
//#endregion
export { createFinalizableDraftStreamControlsForState as a, deliverFinalizableDraftPreview as c, createFinalizableDraftStreamControls as i, clearFinalizableDraftMessage as n, takeMessageIdAfterStop as o, createFinalizableDraftLifecycle as r, createDraftStreamLoop as s, createArmableStallWatchdog as t };
