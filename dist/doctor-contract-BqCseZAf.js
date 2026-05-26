import { i as normalizeLegacyChannelAliases, n as hasLegacyAccountStreamingAliases, r as hasLegacyStreamingAliases, t as asObjectRecord } from "./runtime-doctor-DdFSW1X7.js";
import { n as resolveSlackNativeStreaming, r as resolveSlackStreamingMode } from "./streaming-compat-C_8hxj7n.js";
//#region extensions/slack/src/doctor-contract.ts
function hasLegacySlackStreamingAliases(value) {
	return hasLegacyStreamingAliases(value, { includeNativeTransport: true });
}
function hasLegacySlackChannelAllowAlias(value) {
	const channels = asObjectRecord(asObjectRecord(value)?.channels);
	if (!channels) return false;
	return Object.values(channels).some((channel) => Object.prototype.hasOwnProperty.call(asObjectRecord(channel) ?? {}, "allow"));
}
function normalizeSlackChannelAllowAliases(params) {
	let changed = false;
	const nextChannels = { ...params.channels };
	for (const [channelId, channelValue] of Object.entries(params.channels)) {
		const channel = asObjectRecord(channelValue);
		if (!channel || !Object.prototype.hasOwnProperty.call(channel, "allow")) continue;
		const nextChannel = { ...channel };
		if (nextChannel.enabled === void 0) {
			nextChannel.enabled = channel.allow;
			params.changes.push(`Moved ${params.pathPrefix}.${channelId}.allow → ${params.pathPrefix}.${channelId}.enabled.`);
		} else params.changes.push(`Removed ${params.pathPrefix}.${channelId}.allow (${params.pathPrefix}.${channelId}.enabled already set).`);
		delete nextChannel.allow;
		nextChannels[channelId] = nextChannel;
		changed = true;
	}
	return {
		channels: nextChannels,
		changed
	};
}
const legacyConfigRules = [
	{
		path: ["channels", "slack"],
		message: "channels.slack.streamMode, channels.slack.streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}.",
		match: hasLegacySlackStreamingAliases
	},
	{
		path: [
			"channels",
			"slack",
			"accounts"
		],
		message: "channels.slack.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.accounts.<id>.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}.",
		match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacySlackStreamingAliases)
	},
	{
		path: ["channels", "slack"],
		message: "channels.slack.channels.<id>.allow is legacy; use channels.slack.channels.<id>.enabled instead. Run \"openclaw doctor --fix\".",
		match: hasLegacySlackChannelAllowAlias
	},
	{
		path: [
			"channels",
			"slack",
			"accounts"
		],
		message: "channels.slack.accounts.<id>.channels.<id>.allow is legacy; use channels.slack.accounts.<id>.channels.<id>.enabled instead. Run \"openclaw doctor --fix\".",
		match: (value) => {
			const accounts = asObjectRecord(value);
			if (!accounts) return false;
			return Object.values(accounts).some((account) => hasLegacySlackChannelAllowAlias(account));
		}
	}
];
function normalizeCompatibilityConfig({ cfg }) {
	const rawEntry = asObjectRecord(cfg.channels?.slack);
	if (!rawEntry) return {
		config: cfg,
		changes: []
	};
	const changes = [];
	let updated = rawEntry;
	let changed = false;
	const aliases = normalizeLegacyChannelAliases({
		entry: rawEntry,
		pathPrefix: "channels.slack",
		changes,
		normalizeDm: true,
		normalizeAccountDm: true,
		resolveStreamingOptions: (entry) => ({
			resolvedMode: resolveSlackStreamingMode(entry),
			resolvedNativeTransport: resolveSlackNativeStreaming(entry)
		})
	});
	updated = aliases.entry;
	changed = aliases.changed;
	const channels = asObjectRecord(updated.channels);
	if (channels) {
		const normalized = normalizeSlackChannelAllowAliases({
			channels,
			pathPrefix: "channels.slack.channels",
			changes
		});
		if (normalized.changed) {
			updated = {
				...updated,
				channels: normalized.channels
			};
			changed = true;
		}
	}
	const accounts = asObjectRecord(updated.accounts);
	if (accounts) {
		let accountsChanged = false;
		const nextAccounts = { ...accounts };
		for (const [accountId, accountValue] of Object.entries(accounts)) {
			const account = asObjectRecord(accountValue);
			const channelEntries = asObjectRecord(account?.channels);
			if (!account || !channelEntries) continue;
			const normalized = normalizeSlackChannelAllowAliases({
				channels: channelEntries,
				pathPrefix: `channels.slack.accounts.${accountId}.channels`,
				changes
			});
			if (!normalized.changed) continue;
			nextAccounts[accountId] = {
				...account,
				channels: normalized.channels
			};
			accountsChanged = true;
		}
		if (accountsChanged) {
			updated = {
				...updated,
				accounts: nextAccounts
			};
			changed = true;
		}
	}
	if (!changed) return {
		config: cfg,
		changes: []
	};
	return {
		config: {
			...cfg,
			channels: {
				...cfg.channels,
				slack: updated
			}
		},
		changes
	};
}
//#endregion
export { normalizeCompatibilityConfig as n, legacyConfigRules as t };
