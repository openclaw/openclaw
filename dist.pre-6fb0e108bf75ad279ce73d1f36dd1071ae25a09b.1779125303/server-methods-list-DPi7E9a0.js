import { o as listCoreAdvertisedGatewayMethodNames } from "./core-descriptors-CnKoLag5.js";
import { r as listLoadedChannelPlugins } from "./registry-loaded-4Y_NE_1a.js";
import { t as GATEWAY_AUX_METHODS } from "./server-aux-methods-BvV1RVs5.js";
import { t as GATEWAY_EVENT_UPDATE_AVAILABLE } from "./events-Cz-T59QW.js";
//#region src/gateway/server-methods-list.ts
function listCoreGatewayMethods() {
	return listCoreAdvertisedGatewayMethodNames();
}
function listChannelGatewayMethods() {
	const methods = [];
	for (const plugin of listLoadedChannelPlugins()) {
		methods.push(...plugin.gatewayMethods ?? []);
		for (const descriptor of plugin.gatewayMethodDescriptors ?? []) methods.push(descriptor.name);
	}
	return methods;
}
function listGatewayMethods() {
	return Array.from(new Set([
		...listCoreGatewayMethods(),
		...GATEWAY_AUX_METHODS,
		...listChannelGatewayMethods()
	]));
}
const GATEWAY_EVENTS = [
	"connect.challenge",
	"agent",
	"chat",
	"session.message",
	"session.operation",
	"session.tool",
	"sessions.changed",
	"presence",
	"tick",
	"talk.mode",
	"talk.event",
	"shutdown",
	"health",
	"heartbeat",
	"cron",
	"node.pair.requested",
	"node.pair.resolved",
	"node.invoke.request",
	"device.pair.requested",
	"device.pair.resolved",
	"voicewake.changed",
	"voicewake.routing.changed",
	"exec.approval.requested",
	"exec.approval.resolved",
	"plugin.approval.requested",
	"plugin.approval.resolved",
	GATEWAY_EVENT_UPDATE_AVAILABLE
];
//#endregion
export { listGatewayMethods as n, GATEWAY_EVENTS as t };
