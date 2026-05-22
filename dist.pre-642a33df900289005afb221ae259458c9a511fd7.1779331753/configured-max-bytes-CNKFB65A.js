import { g as maxBytesForKind } from "./mime-DppuT-pZ.js";
//#region src/media/configured-max-bytes.ts
const MB = 1024 * 1024;
function resolveConfiguredMediaMaxBytes(cfg) {
	const configured = cfg?.agents?.defaults?.mediaMaxMb;
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) return Math.floor(configured * MB);
}
function resolveGeneratedMediaMaxBytes(cfg, kind) {
	return resolveConfiguredMediaMaxBytes(cfg) ?? maxBytesForKind(kind);
}
function resolveChannelAccountMediaMaxMb(params) {
	const channelId = params.channel?.trim();
	const accountId = params.accountId?.trim();
	const channelCfg = channelId ? params.cfg.channels?.[channelId] : void 0;
	const channelObj = channelCfg && typeof channelCfg === "object" ? channelCfg : void 0;
	const channelMediaMax = typeof channelObj?.mediaMaxMb === "number" ? channelObj.mediaMaxMb : void 0;
	const accountsObj = channelObj?.accounts && typeof channelObj.accounts === "object" ? channelObj.accounts : void 0;
	const accountCfg = accountId && accountsObj ? accountsObj[accountId] : void 0;
	const accountMediaMax = accountCfg && typeof accountCfg === "object" ? accountCfg.mediaMaxMb : void 0;
	return (typeof accountMediaMax === "number" ? accountMediaMax : void 0) ?? channelMediaMax;
}
//#endregion
export { resolveConfiguredMediaMaxBytes as n, resolveGeneratedMediaMaxBytes as r, resolveChannelAccountMediaMaxMb as t };
