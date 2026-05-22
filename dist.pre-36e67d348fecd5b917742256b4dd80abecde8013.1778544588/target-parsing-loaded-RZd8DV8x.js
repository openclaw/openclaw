import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { m as resolveChannelRouteTargetWithParser } from "./channel-route-CrG2dtax.js";
import { t as getLoadedChannelPluginForRead } from "./registry-loaded-read-Btr82jlz.js";
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
