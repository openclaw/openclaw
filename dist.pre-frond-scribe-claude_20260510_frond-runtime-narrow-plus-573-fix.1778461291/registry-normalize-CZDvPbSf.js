import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { t as getActivePluginChannelRegistryFromState } from "./runtime-channel-state-CBbzbVQu.js";
//#region src/channels/registry-normalize.ts
function listRegisteredChannelPluginEntries() {
	const channelRegistry = getActivePluginChannelRegistryFromState();
	if (channelRegistry?.channels && channelRegistry.channels.length > 0) return channelRegistry.channels;
	return [];
}
function normalizeAnyChannelId(raw) {
	const key = normalizeOptionalLowercaseString(raw);
	if (!key) return null;
	return listRegisteredChannelPluginEntries().find((entry) => {
		const id = normalizeOptionalLowercaseString(entry.plugin.id ?? "") ?? "";
		if (id && id === key) return true;
		return (entry.plugin.meta?.aliases ?? []).some((alias) => normalizeOptionalLowercaseString(alias) === key);
	})?.plugin.id ?? null;
}
//#endregion
export { normalizeAnyChannelId as t };
