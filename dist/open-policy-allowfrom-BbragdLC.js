import { t as sanitizeForLog } from "./ansi-4r6vVvJt.js";
import { t as ensureOpenDmPolicyAllowFromWildcard } from "./dm-access-CP9QxWdj.js";
import { t as asObjectRecord } from "./object-BsiS9JXh.js";
import { t as getDoctorChannelCapabilities } from "./channel-capabilities-BJ5ncwpO.js";
//#region src/commands/doctor/shared/allow-from-mode.ts
function resolveAllowFromMode(channelName) {
	return getDoctorChannelCapabilities(channelName).dmAllowFromMode;
}
//#endregion
//#region src/commands/doctor/shared/open-policy-allowfrom.ts
function collectOpenPolicyAllowFromWarnings(params) {
	if (params.changes.length === 0) return [];
	return [...params.changes.map((line) => sanitizeForLog(line)), `- Run "${params.doctorFixCommand}" to add missing allowFrom wildcards.`];
}
function maybeRepairOpenPolicyAllowFrom(cfg) {
	const channels = cfg.channels;
	if (!channels || typeof channels !== "object") return {
		config: cfg,
		changes: []
	};
	const next = structuredClone(cfg);
	const changes = [];
	const ensureWildcard = (account, prefix, mode) => {
		ensureOpenDmPolicyAllowFromWildcard({
			entry: account,
			mode,
			pathPrefix: prefix,
			changes
		});
	};
	const nextChannels = next.channels;
	for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
		if (!channelConfig || typeof channelConfig !== "object") continue;
		const allowFromMode = resolveAllowFromMode(channelName);
		ensureWildcard(channelConfig, `channels.${channelName}`, allowFromMode);
		const accounts = asObjectRecord(channelConfig.accounts);
		if (!accounts) continue;
		for (const [accountName, accountConfig] of Object.entries(accounts)) if (accountConfig && typeof accountConfig === "object") ensureWildcard(accountConfig, `channels.${channelName}.accounts.${accountName}`, allowFromMode);
	}
	if (changes.length === 0) return {
		config: cfg,
		changes: []
	};
	return {
		config: next,
		changes
	};
}
//#endregion
export { maybeRepairOpenPolicyAllowFrom as n, resolveAllowFromMode as r, collectOpenPolicyAllowFromWarnings as t };
