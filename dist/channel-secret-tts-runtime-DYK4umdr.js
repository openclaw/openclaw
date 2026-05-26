import { c as isRecord } from "./utils-sBTEdeml.js";
import "./shared-Cv5g0_Ch.js";
import { t as collectTtsApiKeyAssignments } from "./runtime-config-collectors-tts-Bm58-KHt.js";
//#region src/secrets/channel-secret-tts-runtime.ts
function collectNestedChannelTtsAssignments(params) {
	const topLevelNested = params.channel[params.nestedKey];
	if (isRecord(topLevelNested) && isRecord(topLevelNested.tts)) collectTtsApiKeyAssignments({
		tts: topLevelNested.tts,
		pathPrefix: `channels.${params.channelKey}.${params.nestedKey}.tts`,
		defaults: params.defaults,
		context: params.context,
		active: params.topLevelActive,
		inactiveReason: params.topInactiveReason
	});
	if (!params.surface.hasExplicitAccounts) return;
	for (const entry of params.surface.accounts) {
		const nested = entry.account[params.nestedKey];
		if (!isRecord(nested) || !isRecord(nested.tts)) continue;
		collectTtsApiKeyAssignments({
			tts: nested.tts,
			pathPrefix: `channels.${params.channelKey}.accounts.${entry.accountId}.${params.nestedKey}.tts`,
			defaults: params.defaults,
			context: params.context,
			active: params.accountActive(entry),
			inactiveReason: typeof params.accountInactiveReason === "function" ? params.accountInactiveReason(entry) : params.accountInactiveReason
		});
	}
}
//#endregion
export { collectNestedChannelTtsAssignments as t };
