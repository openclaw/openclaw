import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as isTruthyEnvValue } from "./env-C3v-quV5.js";
import { n as normalizeAccountId, r as normalizeOptionalAccountId } from "./account-id-9_btbLFO.js";
import { t as createSubsystemLogger } from "./subsystem-BCvJ25zm.js";
import "./runtime-env-RIsNRJZc.js";
import "./string-coerce-runtime-C6AjCoZ-.js";
import { t as createAccountActionGate } from "./account-action-gate-DxMT89hI.js";
import { t as resolveAccountWithDefaultFallback } from "./account-core-4D2zWa5E.js";
import { n as formatSetExplicitDefaultInstruction } from "./default-account-warnings-DxmB9DPp.js";
import "./routing-2IBs6HWP.js";
import { t as resolveTelegramToken } from "./token-CRYAOZqX.js";
import { n as resolveTelegramAccountConfig, t as mergeTelegramAccountConfig } from "./account-config-D_-47ykN.js";
import { r as resolveDefaultTelegramAccountSelection, t as listTelegramAccountIds$1 } from "./account-selection-CkEVP0EK.js";
import util from "node:util";
//#region extensions/telegram/src/accounts.ts
let log = null;
function getLog() {
	if (!log) log = createSubsystemLogger("telegram/accounts");
	return log;
}
function formatDebugArg(value) {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.stack ?? value.message;
	return util.inspect(value, {
		colors: false,
		depth: null,
		compact: true,
		breakLength: Infinity
	});
}
const debugAccounts = (...args) => {
	if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
		const parts = args.map((arg) => formatDebugArg(arg));
		getLog().warn(parts.join(" ").trim());
	}
};
function listTelegramAccountIds(cfg) {
	const ids = listTelegramAccountIds$1(cfg);
	debugAccounts("listTelegramAccountIds", ids);
	return ids;
}
let emittedMissingDefaultWarn = false;
/** @internal Reset the once-per-process warning flag. Exported for tests only. */
function resetMissingDefaultWarnFlag() {
	emittedMissingDefaultWarn = false;
}
function resolveDefaultTelegramAccountId(cfg) {
	const selection = resolveDefaultTelegramAccountSelection(cfg);
	if (selection.shouldWarnMissingDefault && !emittedMissingDefaultWarn) {
		emittedMissingDefaultWarn = true;
		getLog().warn(`channels.telegram: accounts.default is missing; falling back to "${selection.accountId}". ${formatSetExplicitDefaultInstruction("telegram")} to avoid routing surprises in multi-account setups.`);
	}
	return selection.accountId;
}
function createTelegramActionGate(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultTelegramAccountId(params.cfg));
	return createAccountActionGate({
		baseActions: params.cfg.channels?.telegram?.actions,
		accountActions: resolveTelegramAccountConfig(params.cfg, accountId)?.actions
	});
}
function resolveTelegramMediaRuntimeOptions(params) {
	const normalizedAccountId = normalizeOptionalAccountId(params.accountId);
	const accountCfg = normalizedAccountId ? mergeTelegramAccountConfig(params.cfg, normalizedAccountId) : params.cfg.channels?.telegram;
	return {
		token: params.token,
		transport: params.transport,
		apiRoot: accountCfg?.apiRoot,
		trustedLocalFileRoots: accountCfg?.trustedLocalFileRoots,
		dangerouslyAllowPrivateNetwork: accountCfg?.network?.dangerouslyAllowPrivateNetwork
	};
}
function resolveTelegramPollActionGateState(isActionEnabled) {
	const sendMessageEnabled = isActionEnabled("sendMessage");
	const pollEnabled = isActionEnabled("poll");
	return {
		sendMessageEnabled,
		pollEnabled,
		enabled: sendMessageEnabled && pollEnabled
	};
}
function resolveTelegramAccount(params) {
	const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;
	const resolve = (accountId) => {
		const merged = mergeTelegramAccountConfig(params.cfg, accountId);
		const accountEnabled = merged.enabled !== false;
		const enabled = baseEnabled && accountEnabled;
		const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
		debugAccounts("resolve", {
			accountId,
			enabled,
			tokenSource: tokenResolution.source
		});
		return {
			accountId,
			enabled,
			name: normalizeOptionalString(merged.name),
			token: tokenResolution.token,
			tokenSource: tokenResolution.source,
			config: merged
		};
	};
	return resolveAccountWithDefaultFallback({
		accountId: params.accountId,
		normalizeAccountId,
		resolvePrimary: resolve,
		hasCredential: (account) => account.tokenSource !== "none",
		resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg)
	});
}
function listEnabledTelegramAccounts(cfg) {
	if (!(cfg.channels?.telegram?.enabled !== false)) return [];
	return listTelegramAccountIds(cfg).filter((accountId) => mergeTelegramAccountConfig(cfg, accountId).enabled !== false).map((accountId) => resolveTelegramAccount({
		cfg,
		accountId
	}));
}
//#endregion
export { resolveDefaultTelegramAccountId as a, resolveTelegramPollActionGateState as c, resetMissingDefaultWarnFlag as i, listEnabledTelegramAccounts as n, resolveTelegramAccount as o, listTelegramAccountIds as r, resolveTelegramMediaRuntimeOptions as s, createTelegramActionGate as t };
