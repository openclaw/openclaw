import { i as formatErrorMessage } from "./errors-QN8rySzW.js";
import { n as defaultRuntime } from "./runtime-bzt9CHmD.js";
import { l as listDeliverableMessageChannels, s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-qkYXfTa4.js";
import { i as listChannelPlugins } from "./registry-vjc31mTI.js";
import "./plugins-B_QXrzEj.js";
import { n as resolveOutboundChannelPlugin } from "./channel-resolution-C71-OZtl.js";
//#region src/infra/outbound/channel-selection.ts
const getMessageChannels = () => listDeliverableMessageChannels();
function isKnownChannel(value) {
	return getMessageChannels().includes(value);
}
function resolveKnownChannel(value) {
	const normalized = normalizeMessageChannel(value);
	if (!normalized) return;
	if (!isDeliverableMessageChannel(normalized)) return;
	if (!isKnownChannel(normalized)) return;
	return normalized;
}
function resolveAvailableKnownChannel(params) {
	const normalized = resolveKnownChannel(params.value);
	if (!normalized) return;
	return resolveOutboundChannelPlugin({
		channel: normalized,
		cfg: params.cfg
	}) ? normalized : void 0;
}
function isAccountEnabled(account) {
	if (!account || typeof account !== "object") return true;
	return account.enabled !== false;
}
const loggedChannelSelectionErrors = /* @__PURE__ */ new Set();
function logChannelSelectionError(params) {
	const message = formatErrorMessage(params.error);
	const key = `${params.pluginId}:${params.accountId}:${params.operation}:${message}`;
	if (loggedChannelSelectionErrors.has(key)) return;
	loggedChannelSelectionErrors.add(key);
	defaultRuntime.error?.(`[channel-selection] ${params.pluginId}(${params.accountId}) ${params.operation} failed: ${message}`);
}
async function isPluginConfigured(plugin, cfg) {
	const accountIds = plugin.config.listAccountIds(cfg);
	if (accountIds.length === 0) return false;
	for (const accountId of accountIds) {
		let account;
		try {
			account = plugin.config.resolveAccount(cfg, accountId);
		} catch (error) {
			logChannelSelectionError({
				pluginId: plugin.id,
				accountId,
				operation: "resolveAccount",
				error
			});
			continue;
		}
		if (!(plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : isAccountEnabled(account))) continue;
		if (!plugin.config.isConfigured) return true;
		let configured = false;
		try {
			configured = await plugin.config.isConfigured(account, cfg);
		} catch (error) {
			logChannelSelectionError({
				pluginId: plugin.id,
				accountId,
				operation: "isConfigured",
				error
			});
			continue;
		}
		if (configured) return true;
	}
	return false;
}
async function listConfiguredMessageChannels(cfg) {
	const channels = [];
	for (const plugin of listChannelPlugins()) {
		if (!isKnownChannel(plugin.id)) continue;
		if (await isPluginConfigured(plugin, cfg)) channels.push(plugin.id);
	}
	return channels;
}
async function resolveMessageChannelSelection(params) {
	const normalized = normalizeMessageChannel(params.channel);
	if (normalized) {
		const availableExplicit = resolveAvailableKnownChannel({
			cfg: params.cfg,
			value: normalized
		});
		if (!availableExplicit) {
			const fallback = resolveAvailableKnownChannel({
				cfg: params.cfg,
				value: params.fallbackChannel
			});
			if (fallback) return {
				channel: fallback,
				configured: [],
				source: "tool-context-fallback"
			};
			if (!isKnownChannel(normalized)) throw new Error(`Unknown channel: ${normalized}`);
			throw new Error(`Channel is unavailable: ${normalized}`);
		}
		return {
			channel: availableExplicit,
			configured: [],
			source: "explicit"
		};
	}
	const fallback = resolveAvailableKnownChannel({
		cfg: params.cfg,
		value: params.fallbackChannel
	});
	if (fallback) return {
		channel: fallback,
		configured: [],
		source: "tool-context-fallback"
	};
	const configured = await listConfiguredMessageChannels(params.cfg);
	if (configured.length === 1) return {
		channel: configured[0],
		configured,
		source: "single-configured"
	};
	if (configured.length === 0) throw new Error("Channel is required (no configured channels detected).");
	throw new Error(`Channel is required when multiple channels are configured: ${configured.join(", ")}`);
}
//#endregion
export { resolveMessageChannelSelection as n, listConfiguredMessageChannels as t };
