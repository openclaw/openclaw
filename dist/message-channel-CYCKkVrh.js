import { r as normalizeChatChannelId, t as CHANNEL_IDS } from "./ids-BE_yccbC.js";
import { t as getChatChannelMeta } from "./chat-meta-2H4wOcrq.js";
import { i as listRegisteredChannelPluginIds, r as getRegisteredChannelPluginMeta } from "./registry-CtWyD2pE.js";
import { c as normalizeGatewayClientName, i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES, s as normalizeGatewayClientMode } from "./client-info-BVWE_ra1.js";
import { n as normalizeMessageChannel$1, r as INTERNAL_MESSAGE_CHANNEL } from "./message-channel-core-BoUoCGOD.js";
//#region src/utils/message-channel-normalize.ts
function normalizeMessageChannel(raw) {
	return normalizeMessageChannel$1(raw);
}
const listPluginChannelIds = () => {
	return listRegisteredChannelPluginIds();
};
const listDeliverableMessageChannels = () => Array.from(new Set([...CHANNEL_IDS, ...listPluginChannelIds()]));
const listGatewayMessageChannels = () => [...listDeliverableMessageChannels(), INTERNAL_MESSAGE_CHANNEL];
function isGatewayMessageChannel(value) {
	return listGatewayMessageChannels().includes(value);
}
function isDeliverableMessageChannel(value) {
	return listDeliverableMessageChannels().includes(value);
}
function resolveGatewayMessageChannel(raw) {
	const normalized = normalizeMessageChannel(raw);
	if (!normalized) return;
	return isGatewayMessageChannel(normalized) ? normalized : void 0;
}
function resolveMessageChannel(primary, fallback) {
	return normalizeMessageChannel(primary) ?? normalizeMessageChannel(fallback);
}
//#endregion
//#region src/utils/message-channel.ts
function isGatewayCliClient(client) {
	return normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.CLI;
}
function isOperatorUiClient(client) {
	const clientId = normalizeGatewayClientName(client?.id);
	return clientId === GATEWAY_CLIENT_NAMES.CONTROL_UI || clientId === GATEWAY_CLIENT_NAMES.TUI;
}
function isBrowserOperatorUiClient(client) {
	return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.CONTROL_UI;
}
function isInternalMessageChannel(raw) {
	return normalizeMessageChannel(raw) === INTERNAL_MESSAGE_CHANNEL;
}
function isWebchatClient(client) {
	if (normalizeGatewayClientMode(client?.mode) === GATEWAY_CLIENT_MODES.WEBCHAT) return true;
	return normalizeGatewayClientName(client?.id) === GATEWAY_CLIENT_NAMES.WEBCHAT_UI;
}
function isMarkdownCapableMessageChannel(raw) {
	const channel = normalizeMessageChannel(raw);
	if (!channel) return false;
	if (channel === "webchat" || channel === "tui") return true;
	const builtInChannel = normalizeChatChannelId(channel);
	if (builtInChannel) return getChatChannelMeta(builtInChannel).markdownCapable === true;
	return getRegisteredChannelPluginMeta(channel)?.markdownCapable === true;
}
//#endregion
export { isOperatorUiClient as a, isGatewayMessageChannel as c, resolveGatewayMessageChannel as d, resolveMessageChannel as f, isMarkdownCapableMessageChannel as i, listDeliverableMessageChannels as l, isGatewayCliClient as n, isWebchatClient as o, isInternalMessageChannel as r, isDeliverableMessageChannel as s, isBrowserOperatorUiClient as t, normalizeMessageChannel as u };
