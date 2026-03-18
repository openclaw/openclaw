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
//#region src/channels/native-command-session-targets.ts
function resolveNativeCommandSessionTargets(params) {
	const rawSessionKey = params.boundSessionKey ?? `agent:${params.agentId}:${params.sessionPrefix}:${params.userId}`;
	return {
		sessionKey: params.lowercaseSessionKey ? rawSessionKey.toLowerCase() : rawSessionKey,
		commandTargetSessionKey: params.boundSessionKey ?? params.targetSessionKey
	};
}
//#endregion
export { createDraftStreamLoop as n, resolveNativeCommandSessionTargets as t };
