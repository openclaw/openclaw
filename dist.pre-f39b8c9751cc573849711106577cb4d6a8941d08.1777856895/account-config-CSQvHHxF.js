import { t as DEFAULT_ACCOUNT_ID } from "./account-id-fkYplFFW.js";
import { t as resolveAccountEntry } from "./account-lookup-BtBP9pcu.js";
import { a as resolveChannelStreamingChunkMode, i as resolveChannelStreamingBlockEnabled } from "./channel-streaming-C02Um11c.js";
import { a as mergeAccountConfig, s as resolveMergedAccountConfig } from "./account-helpers-CZufvFy_.js";
import "./account-core-Devna-8N.js";
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
