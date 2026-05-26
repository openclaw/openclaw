import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { l as listDeliverableMessageChannels, s as isDeliverableMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { r as resolveOutboundChannelPlugin } from "./channel-resolution-Ecs0HEdK.js";
import { t as resolveMissingOfficialExternalChannelPluginRepairHint } from "./official-external-plugin-repair-hints-CS7WhtMH.js";
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
		cfg: params.cfg,
		allowBootstrap: true
	}) ? normalized : void 0;
}
function isConfiguredChannel(cfg, channelId) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return false;
	const entry = channels[channelId];
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
	return entry.enabled !== false;
}
function listConfiguredOfficialExternalRepairHints(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object" || Array.isArray(channels)) return [];
	return Object.keys(channels).filter((channelId) => isConfiguredChannel(cfg, channelId)).map((channelId) => resolveMissingOfficialExternalChannelPluginRepairHint({
		config: cfg,
		channelId
	})).filter((hint) => Boolean(hint));
}
function formatMissingOfficialExternalChannelsMessage(hints) {
	if (hints.length === 1) {
		const hint = hints[0];
		if (!hint) return "";
		return `Configured official external channel ${hint.label} is missing its plugin. ${hint.repairHint}`;
	}
	return `Configured official external channels ${hints.map((hint) => hint.label).join(", ")} are missing their plugins. Run: openclaw doctor --fix, or install individually: ${hints.map((hint) => hint.installCommand).join("; ")}.`;
}
function formatNoConfiguredChannelsMessage() {
	return [
		"Channel is required (no configured channels detected).",
		"Run openclaw channels add to configure one, or pass --channel <channel> after enabling a channel.",
		"Use openclaw channels list --all to see available channel ids."
	].join(" ");
}
function formatMultipleConfiguredChannelsMessage(configured) {
	return [`Channel is required when multiple channels are configured: ${configured.join(", ")}.`, "Pass --channel <channel> to choose one."].join(" ");
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
			const repairHint = isConfiguredChannel(params.cfg, normalized) ? resolveMissingOfficialExternalChannelPluginRepairHint({
				config: params.cfg,
				channelId: normalized
			}) : null;
			if (repairHint?.channelId === normalized) throw new Error(`Channel is unavailable: ${normalized}. ${repairHint.repairHint}`);
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
	if (configured.length === 0) {
		const repairHints = listConfiguredOfficialExternalRepairHints(params.cfg);
		if (repairHints.length > 0) throw new Error(`Channel is required (no available channels detected). ${formatMissingOfficialExternalChannelsMessage(repairHints)}`);
		throw new Error(formatNoConfiguredChannelsMessage());
	}
	throw new Error(formatMultipleConfiguredChannelsMessage(configured));
}
//#endregion
export { resolveMessageChannelSelection as n, listConfiguredMessageChannels as t };
