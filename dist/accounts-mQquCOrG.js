import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { n as normalizeAccountId } from "./account-id-CwBWagLE.js";
import { t as resolveAccountEntry } from "./account-lookup-DAEppsQ5.js";
import { m as mapAllowFromEntries } from "./channel-config-helpers-Dzal6cfS.js";
import { a as resolveChannelDmAllowFrom, n as normalizeChannelDmPolicy, o as resolveChannelDmPolicy } from "./dm-access-B2x-maJ2.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { t as createAccountActionGate } from "./account-action-gate-kHpP7T33.js";
import { s as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-Ba4hZbOH.js";
import "./routing-BfSZVtOk.js";
import { n as resolveDiscordToken, r as selectDiscordRuntimeConfig } from "./token-eQBVtRgR.js";
//#region extensions/discord/src/accounts.ts
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("discord");
const listDiscordAccountIds = listAccountIds;
const resolveDefaultDiscordAccountId = resolveDefaultAccountId;
function resolveDiscordAccountConfig(cfg, accountId) {
	return resolveAccountEntry(cfg.channels?.discord?.accounts, accountId);
}
function mergeDiscordAccountConfig(cfg, accountId) {
	return resolveMergedAccountConfig({
		channelConfig: cfg.channels?.discord,
		accounts: cfg.channels?.discord?.accounts,
		accountId
	});
}
function resolveDiscordAccountAllowFrom(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultDiscordAccountId(params.cfg));
	const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
	const rootConfig = params.cfg.channels?.discord;
	const allowFrom = resolveChannelDmAllowFrom({
		account: accountConfig,
		parent: rootConfig
	});
	return allowFrom ? mapAllowFromEntries(allowFrom) : void 0;
}
function resolveDiscordAccountDmPolicy(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultDiscordAccountId(params.cfg));
	const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
	const rootConfig = params.cfg.channels?.discord;
	return normalizeChannelDmPolicy(resolveChannelDmPolicy({
		account: accountConfig,
		parent: rootConfig,
		defaultPolicy: "pairing"
	}));
}
function createDiscordActionGate(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultDiscordAccountId(params.cfg));
	return createAccountActionGate({
		baseActions: params.cfg.channels?.discord?.actions,
		accountActions: resolveDiscordAccountConfig(params.cfg, accountId)?.actions
	});
}
function resolveDiscordAccount(params) {
	const cfg = selectDiscordRuntimeConfig(params.cfg);
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultDiscordAccountId(cfg));
	const baseEnabled = cfg.channels?.discord?.enabled !== false;
	const merged = mergeDiscordAccountConfig(cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const tokenResolution = resolveDiscordToken(cfg, { accountId });
	return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		token: tokenResolution.token,
		tokenSource: tokenResolution.source,
		tokenStatus: tokenResolution.tokenStatus,
		config: merged
	};
}
function resolveDiscordMaxLinesPerMessage(params) {
	if (typeof params.discordConfig?.maxLinesPerMessage === "number") return params.discordConfig.maxLinesPerMessage;
	return resolveDiscordAccount({
		cfg: params.cfg,
		accountId: params.accountId
	}).config.maxLinesPerMessage;
}
function resolveDiscordAccountTokenOwner(params) {
	const token = params.token.trim();
	if (!token) return;
	let owner;
	const accountIds = listDiscordAccountIds(params.cfg);
	for (const [index, accountId] of accountIds.entries()) {
		const account = resolveDiscordAccount({
			cfg: params.cfg,
			accountId
		});
		const accountToken = account.token.trim();
		if (!account.enabled || accountToken !== token) continue;
		const priority = account.tokenSource === "config" ? 2 : account.tokenSource === "env" ? 1 : 0;
		if (!owner || priority > owner.priority) {
			owner = {
				accountId: account.accountId,
				priority,
				index
			};
			continue;
		}
		if (priority === owner.priority && index < owner.index) owner = {
			accountId: account.accountId,
			priority,
			index
		};
	}
	return owner?.accountId;
}
function resolveDiscordDuplicateTokenOwner(params) {
	const owner = resolveDiscordAccountTokenOwner({
		cfg: params.cfg,
		token: params.account.token
	});
	return owner && owner !== params.account.accountId ? owner : void 0;
}
function isDiscordAccountEnabledForRuntime(account, cfg) {
	return account.enabled && !resolveDiscordDuplicateTokenOwner({
		cfg,
		account
	});
}
function resolveDiscordAccountDisabledReason(account, cfg) {
	if (!account.enabled) return "disabled";
	const owner = resolveDiscordDuplicateTokenOwner({
		cfg,
		account
	});
	return owner ? `duplicate bot token; using account "${owner}"` : "disabled";
}
function listEnabledDiscordAccounts(cfg) {
	return listDiscordAccountIds(cfg).map((accountId) => resolveDiscordAccount({
		cfg,
		accountId
	})).filter((account) => isDiscordAccountEnabledForRuntime(account, cfg));
}
//#endregion
export { mergeDiscordAccountConfig as a, resolveDiscordAccountAllowFrom as c, resolveDiscordAccountDmPolicy as d, resolveDiscordMaxLinesPerMessage as f, listEnabledDiscordAccounts as i, resolveDiscordAccountConfig as l, isDiscordAccountEnabledForRuntime as n, resolveDefaultDiscordAccountId as o, listDiscordAccountIds as r, resolveDiscordAccount as s, createDiscordActionGate as t, resolveDiscordAccountDisabledReason as u };
