import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { m as resolveChannelRouteTargetWithParser } from "./channel-route-L2PJ-xNE.js";
import { t as getLoadedChannelPluginForRead } from "./registry-loaded-read-DQJDORLt.js";
//#region src/channels/plugins/target-parsing-loaded.ts
function parseExplicitTargetForLoadedChannel(channel, rawTarget) {
	const resolvedChannel = normalizeOptionalString(channel);
	if (!resolvedChannel) return null;
	return getLoadedChannelPluginForRead(resolvedChannel)?.messaging?.parseExplicitTarget?.({ raw: rawTarget }) ?? null;
}
function resolveRouteTargetForLoadedChannel(params) {
	return resolveChannelRouteTargetWithParser({
		...params,
		parseExplicitTarget: parseExplicitTargetForLoadedChannel
	});
}
//#endregion
export { resolveRouteTargetForLoadedChannel as n, parseExplicitTargetForLoadedChannel as t };
