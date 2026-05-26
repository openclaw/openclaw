//#region src/infra/channel-runtime-context.ts
const NOOP_DISPOSE = () => {};
function resolveScopedRuntimeContextRegistry(params) {
	const runtimeContexts = resolveRuntimeContextRegistry(params);
	if (runtimeContexts && typeof runtimeContexts.register === "function" && typeof runtimeContexts.get === "function" && typeof runtimeContexts.watch === "function") return runtimeContexts;
	throw new Error("channelRuntime must provide runtimeContexts.register/get/watch; pass createPluginRuntime().channel or omit channelRuntime.");
}
function resolveRuntimeContextRegistry(params) {
	return params.channelRuntime?.runtimeContexts ?? null;
}
function registerChannelRuntimeContext(params) {
	const runtimeContexts = resolveRuntimeContextRegistry(params);
	if (!runtimeContexts) return null;
	return runtimeContexts.register({
		channelId: params.channelId,
		accountId: params.accountId,
		capability: params.capability,
		context: params.context,
		abortSignal: params.abortSignal
	});
}
function getChannelRuntimeContext(params) {
	const runtimeContexts = resolveRuntimeContextRegistry(params);
	if (!runtimeContexts) return;
	return runtimeContexts.get({
		channelId: params.channelId,
		accountId: params.accountId,
		capability: params.capability
	});
}
function watchChannelRuntimeContexts(params) {
	const runtimeContexts = resolveRuntimeContextRegistry(params);
	if (!runtimeContexts) return null;
	return runtimeContexts.watch({
		channelId: params.channelId,
		accountId: params.accountId,
		capability: params.capability,
		onEvent: params.onEvent
	});
}
function createTaskScopedChannelRuntime(params) {
	const baseRuntime = params.channelRuntime;
	if (!baseRuntime) return {
		channelRuntime: void 0,
		dispose: NOOP_DISPOSE
	};
	const runtimeContexts = resolveScopedRuntimeContextRegistry({ channelRuntime: baseRuntime });
	const trackedLeases = /* @__PURE__ */ new Set();
	const trackLease = (lease) => {
		trackedLeases.add(lease);
		let disposed = false;
		return { dispose: () => {
			if (disposed) return;
			disposed = true;
			trackedLeases.delete(lease);
			lease.dispose();
		} };
	};
	return {
		channelRuntime: {
			...baseRuntime,
			runtimeContexts: {
				...runtimeContexts,
				register: (registerParams) => {
					return trackLease(runtimeContexts.register(registerParams));
				}
			}
		},
		dispose: () => {
			for (const lease of Array.from(trackedLeases)) lease.dispose();
		}
	};
}
//#endregion
export { watchChannelRuntimeContexts as i, getChannelRuntimeContext as n, registerChannelRuntimeContext as r, createTaskScopedChannelRuntime as t };
