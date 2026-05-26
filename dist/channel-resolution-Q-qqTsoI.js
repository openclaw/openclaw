import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-s-A-ruKR.js";
import { a as getActivePluginRegistry } from "./runtime-CFKT2mp_.js";
import { n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-BdfZSqhE2.js";
import "./plugins-YTdL-Pji.js";
import { t as bootstrapOutboundChannelPlugin } from "./channel-bootstrap.runtime-C5fESs_Q.js";
//#region src/infra/outbound/channel-resolution.ts
function normalizeDeliverableOutboundChannel(raw) {
	const normalized = normalizeMessageChannel(raw);
	if (!normalized || !isDeliverableMessageChannel(normalized)) return;
	return normalized;
}
function maybeBootstrapChannelPlugin(params) {
	bootstrapOutboundChannelPlugin(params);
}
function resolveDirectFromActiveRegistry(channel) {
	const activeRegistry = getActivePluginRegistry();
	if (!activeRegistry) return;
	for (const entry of activeRegistry.channels) {
		const plugin = entry?.plugin;
		if (plugin?.id === channel) return plugin;
	}
}
function resolveOutboundChannelPlugin(params) {
	const normalized = normalizeDeliverableOutboundChannel(params.channel);
	if (!normalized) return;
	const resolveLoaded = () => getLoadedChannelPlugin(normalized);
	const resolve = () => getChannelPlugin(normalized);
	const current = resolveLoaded();
	if (current) return current;
	const directCurrent = resolveDirectFromActiveRegistry(normalized);
	if (directCurrent) return directCurrent;
	if (params.allowBootstrap !== true) return resolve();
	maybeBootstrapChannelPlugin({
		channel: normalized,
		cfg: params.cfg
	});
	return resolveLoaded() ?? resolveDirectFromActiveRegistry(normalized) ?? resolve();
}
function resolveOutboundChannelMessageAdapter(params) {
	return resolveOutboundChannelPlugin(params)?.message;
}
//#endregion
export { resolveOutboundChannelMessageAdapter as n, resolveOutboundChannelPlugin as r, normalizeDeliverableOutboundChannel as t };
