//#region src/auto-reply/inbound-debounce.ts
const resolveMs = (value) => {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return Math.max(0, Math.trunc(value));
};
const resolveChannelOverride = (params) => {
	if (!params.byChannel) return;
	return resolveMs(params.byChannel[params.channel]);
};
function resolveInboundDebounceMs(params) {
	const inbound = params.cfg.messages?.inbound;
	const override = resolveMs(params.overrideMs);
	const byChannel = resolveChannelOverride({
		byChannel: inbound?.byChannel,
		channel: params.channel
	});
	const base = resolveMs(inbound?.debounceMs);
	return override ?? byChannel ?? base ?? 0;
}
const DEFAULT_MAX_TRACKED_KEYS = 2048;
function createInboundDebouncer(params) {
	const buffers = /* @__PURE__ */ new Map();
	const keyChains = /* @__PURE__ */ new Map();
	const defaultDebounceMs = Math.max(0, Math.trunc(params.debounceMs));
	const maxTrackedKeys = Math.max(1, Math.trunc(params.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS));
	const resolveDebounceMs = (item) => {
		const resolved = params.resolveDebounceMs?.(item);
		if (typeof resolved !== "number" || !Number.isFinite(resolved)) return defaultDebounceMs;
		return Math.max(0, Math.trunc(resolved));
	};
	const runFlush = async (items) => {
		try {
			await params.onFlush(items);
		} catch (err) {
			try {
				params.onError?.(err, items);
			} catch {}
		}
	};
	const enqueueKeyTask = (key, task) => {
		const next = (keyChains.get(key) ?? Promise.resolve()).catch(() => void 0).then(task);
		const settled = next.catch(() => void 0);
		keyChains.set(key, settled);
		const cleanup = () => {
			if (keyChains.get(key) === settled) keyChains.delete(key);
		};
		settled.then(cleanup, cleanup);
		return next;
	};
	const enqueueReservedKeyTask = (key, task) => {
		let readyReleased = false;
		let releaseReady;
		const ready = new Promise((resolve) => {
			releaseReady = resolve;
		});
		return {
			task: enqueueKeyTask(key, async () => {
				await ready;
				await task();
			}),
			release: () => {
				if (readyReleased) return;
				readyReleased = true;
				releaseReady();
			}
		};
	};
	const releaseBuffer = (buffer) => {
		if (buffer.readyReleased) return;
		buffer.readyReleased = true;
		buffer.releaseReady();
	};
	const flushBuffer = async (key, buffer) => {
		if (buffers.get(key) === buffer) buffers.delete(key);
		if (buffer.timeout) {
			clearTimeout(buffer.timeout);
			buffer.timeout = null;
		}
		releaseBuffer(buffer);
		await buffer.task;
	};
	const flushKey = async (key) => {
		const buffer = buffers.get(key);
		if (!buffer) return;
		await flushBuffer(key, buffer);
	};
	const scheduleFlush = (key, buffer) => {
		if (buffer.timeout) clearTimeout(buffer.timeout);
		buffer.timeout = setTimeout(async () => {
			await flushBuffer(key, buffer);
		}, buffer.debounceMs);
		buffer.timeout.unref?.();
	};
	const canTrackKey = (key) => {
		if (buffers.has(key) || keyChains.has(key)) return true;
		return new Set([...buffers.keys(), ...keyChains.keys()]).size < maxTrackedKeys;
	};
	const enqueue = async (item) => {
		const key = params.buildKey(item);
		const debounceMs = resolveDebounceMs(item);
		if (!(debounceMs > 0 && (params.shouldDebounce?.(item) ?? true)) || !key) {
			if (key) {
				if (buffers.has(key)) {
					const reservedTask = enqueueReservedKeyTask(key, async () => {
						await runFlush([item]);
					});
					try {
						await flushKey(key);
					} finally {
						reservedTask.release();
					}
					await reservedTask.task;
					return;
				}
				if (keyChains.has(key)) {
					await enqueueKeyTask(key, async () => {
						await runFlush([item]);
					});
					return;
				}
				await runFlush([item]);
			} else await runFlush([item]);
			return;
		}
		const existing = buffers.get(key);
		if (existing) {
			existing.items.push(item);
			existing.debounceMs = debounceMs;
			scheduleFlush(key, existing);
			return;
		}
		if (!canTrackKey(key)) {
			await enqueueKeyTask(key, async () => {
				await runFlush([item]);
			});
			return;
		}
		let buffer;
		const reservedTask = enqueueReservedKeyTask(key, async () => {
			if (buffer.items.length === 0) return;
			await runFlush(buffer.items);
		});
		buffer = {
			items: [item],
			timeout: null,
			debounceMs,
			releaseReady: reservedTask.release,
			readyReleased: false,
			task: reservedTask.task
		};
		buffers.set(key, buffer);
		scheduleFlush(key, buffer);
	};
	return {
		enqueue,
		flushKey
	};
}
//#endregion
export { resolveInboundDebounceMs as n, createInboundDebouncer as t };
