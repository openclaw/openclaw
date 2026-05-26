import { a as createLazyRuntimeSurface } from "./lazy-runtime-D-7_JraP.js";
import { n as createOutboundSendDepsFromCliSource, t as CLI_OUTBOUND_SEND_FACTORY } from "./outbound-send-mapping-B_rQ2on5.js";
//#region src/cli/deps.ts
const NON_CHANNEL_DEP_KEYS = new Set([
	"__proto__",
	"constructor",
	"cron",
	"cronConfig",
	"cronEnabled",
	"defaultAgentId",
	"enqueueSystemEvent",
	"getQueueSize",
	"hasOwnProperty",
	"inspect",
	"log",
	"migrateOrphanedSessionKeys",
	"nowMs",
	"onEvent",
	"requestHeartbeat",
	"resolveSessionStorePath",
	"runHeartbeatOnce",
	"runIsolatedAgentJob",
	"runtime",
	"sendCronFailureAlert",
	"sessionStorePath",
	"storePath",
	"then",
	"toJSON",
	"toString",
	"valueOf"
]);
const senderCache = /* @__PURE__ */ new Map();
/**
* Create a lazy-loading send function proxy for a channel.
* The channel's module is loaded on first call and cached for reuse.
*/
function createLazySender(channelId, loader) {
	const loadRuntimeSend = createLazyRuntimeSurface(loader, ({ runtimeSend }) => runtimeSend);
	return async (...args) => {
		let cached = senderCache.get(channelId);
		if (!cached) {
			cached = loadRuntimeSend();
			senderCache.set(channelId, cached);
		}
		return await (await cached).sendMessage(...args);
	};
}
function createDefaultDeps() {
	const deps = {};
	const resolveSender = (channelId) => createLazySender(channelId, async () => {
		const { createChannelOutboundRuntimeSend } = await import("./channel-outbound-send-ShF1mn7y.js");
		return { runtimeSend: createChannelOutboundRuntimeSend({
			channelId,
			unavailableMessage: `${channelId} outbound adapter is unavailable.`
		}) };
	});
	Object.defineProperty(deps, CLI_OUTBOUND_SEND_FACTORY, {
		configurable: false,
		enumerable: false,
		value: resolveSender,
		writable: false
	});
	return new Proxy(deps, { get(target, property, receiver) {
		if (typeof property !== "string") return Reflect.get(target, property, receiver);
		const existing = Reflect.get(target, property, receiver);
		if (existing !== void 0 || NON_CHANNEL_DEP_KEYS.has(property)) return existing;
		const sender = resolveSender(property);
		Reflect.set(target, property, sender, receiver);
		return sender;
	} });
}
function createOutboundSendDeps(deps) {
	return createOutboundSendDepsFromCliSource(deps);
}
//#endregion
export { createOutboundSendDeps as n, createDefaultDeps as t };
