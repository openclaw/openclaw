import { s as normalizeOptionalLowercaseString } from "./string-coerce-Bje8XVt9.js";
import { t as getActivePluginChannelRegistryFromState } from "./runtime-channel-state-BUHEIolZ.js";
import { n as normalizeMessageChannel } from "./message-channel-core-CFCQaimB.js";
//#region src/infra/outbound/channel-target-prefix.ts
const TARGET_KIND_PREFIXES = new Set([
	"channel",
	"conversation",
	"dm",
	"group",
	"room",
	"thread",
	"user"
]);
function resolvePluginTargetPrefix(prefix) {
	const normalizedPrefix = normalizeOptionalLowercaseString(prefix);
	if (!normalizedPrefix) return;
	const registry = getActivePluginChannelRegistryFromState();
	for (const entry of registry?.channels ?? []) {
		const plugin = entry.plugin;
		const channelId = normalizeOptionalLowercaseString(plugin.id);
		const candidates = plugin.messaging?.targetPrefixes ?? [];
		if (channelId && candidates.some((candidate) => normalizeOptionalLowercaseString(candidate) === normalizedPrefix)) return channelId;
	}
}
function resolveChannelTargetProviderPrefix(raw) {
	const prefix = normalizeOptionalLowercaseString(/^\s*([a-z][a-z0-9_-]*):/i.exec(raw ?? "")?.[1]);
	if (!prefix || TARGET_KIND_PREFIXES.has(prefix)) return;
	const channel = resolvePluginTargetPrefix(prefix);
	return channel ? {
		prefix,
		channel
	} : void 0;
}
function resolveTargetPrefixedChannel(raw) {
	return resolveChannelTargetProviderPrefix(raw)?.channel;
}
function validateTargetProviderPrefix(params) {
	const selectedChannel = normalizeMessageChannel(params.channel) ?? normalizeOptionalLowercaseString(params.channel);
	if (!selectedChannel || selectedChannel === "last") return;
	const prefixed = resolveChannelTargetProviderPrefix(params.to);
	if (!prefixed || prefixed.channel === selectedChannel) return;
	return /* @__PURE__ */ new Error(`Target prefix "${prefixed.prefix}:" belongs to ${prefixed.channel}, not ${selectedChannel}.`);
}
//#endregion
export { validateTargetProviderPrefix as n, resolveTargetPrefixedChannel as t };
