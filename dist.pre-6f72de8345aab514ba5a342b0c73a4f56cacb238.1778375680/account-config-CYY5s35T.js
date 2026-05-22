import { t as DEFAULT_ACCOUNT_ID } from "./account-id-9_btbLFO.js";
import { t as resolveAccountEntry } from "./account-lookup-Cm9Y4_XU.js";
import { v as resolveChannelStreamingBlockEnabled, y as resolveChannelStreamingChunkMode } from "./channel-streaming-Cm4e9zsv.js";
import { a as mergeAccountConfig, s as resolveMergedAccountConfig } from "./account-helpers-Cdor3h9C.js";
import "./account-core-BoQ_gkwx.js";
//#region extensions/whatsapp/src/account-config.ts
function resolveWhatsAppDefaultAccountSharedConfig(cfg) {
	const defaultAccount = resolveAccountEntry(cfg.channels?.whatsapp?.accounts, DEFAULT_ACCOUNT_ID);
	if (!defaultAccount) return;
	const { enabled: _ignoredEnabled, name: _ignoredName, authDir: _ignoredAuthDir, selfChatMode: _ignoredSelfChatMode, ...sharedDefaults } = defaultAccount;
	return sharedDefaults;
}
function _resolveWhatsAppAccountConfig(cfg, accountId) {
	return resolveAccountEntry(cfg.channels?.whatsapp?.accounts, accountId);
}
function resolveMergedNamedWhatsAppAccountConfig(params) {
	const rootCfg = params.cfg.channels?.whatsapp;
	const accountConfig = _resolveWhatsAppAccountConfig(params.cfg, params.accountId);
	return {
		...mergeAccountConfig({
			channelConfig: rootCfg,
			accountConfig: void 0,
			omitKeys: ["defaultAccount"]
		}),
		...resolveWhatsAppDefaultAccountSharedConfig(params.cfg),
		...accountConfig
	};
}
function resolveMergedWhatsAppAccountConfig(params) {
	const rootCfg = params.cfg.channels?.whatsapp;
	const accountId = params.accountId?.trim() || rootCfg?.defaultAccount || "default";
	const base = resolveMergedAccountConfig({
		channelConfig: rootCfg,
		accounts: rootCfg?.accounts,
		accountId,
		omitKeys: ["defaultAccount"]
	});
	const merged = accountId === "default" ? base : resolveMergedNamedWhatsAppAccountConfig({
		cfg: params.cfg,
		accountId
	});
	return {
		accountId,
		...merged,
		chunkMode: resolveChannelStreamingChunkMode(merged) ?? merged.chunkMode,
		blockStreaming: resolveChannelStreamingBlockEnabled(merged) ?? merged.blockStreaming
	};
}
//#endregion
export { resolveMergedWhatsAppAccountConfig as t };
