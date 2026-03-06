//#region src/plugin-sdk/keyed-async-queue.ts
function enqueueKeyedTask(params) {
	params.hooks?.onEnqueue?.();
	const current = (params.tails.get(params.key) ?? Promise.resolve()).catch(() => void 0).then(params.task).finally(() => {
		params.hooks?.onSettle?.();
	});
	const tail = current.then(() => void 0, () => void 0);
	params.tails.set(params.key, tail);
	tail.finally(() => {
		if (params.tails.get(params.key) === tail) params.tails.delete(params.key);
	});
	return current;
}
var KeyedAsyncQueue = class {
	constructor() {
		this.tails = /* @__PURE__ */ new Map();
	}
	getTailMapForTesting() {
		return this.tails;
	}
	enqueue(key, task, hooks) {
		return enqueueKeyedTask({
			tails: this.tails,
			key,
			task,
			...hooks ? { hooks } : {}
		});
	}
};

//#endregion
export { KeyedAsyncQueue, enqueueKeyedTask };