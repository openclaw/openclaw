import { s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-B9xZ12q8.js";
import { a as getActivePluginRegistry } from "./runtime-C5J6hl53.js";
import { n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-BDy7VEax.js";
import "./plugins-BwY4oKrD.js";
import { t as bootstrapOutboundChannelPlugin } from "./channel-bootstrap.runtime-CwvAIHfl.js";
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
