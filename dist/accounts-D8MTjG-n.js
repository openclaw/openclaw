import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import "./account-resolution-Dy8RKAMt.js";
//#region extensions/signal/src/accounts.ts
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal", { implicitDefaultAccount: { channelKeys: ["account"] } });
const listSignalAccountIds = listAccountIds;
const resolveDefaultSignalAccountId = resolveDefaultAccountId;
function mergeSignalAccountConfig(cfg, accountId) {
	return resolveMergedAccountConfig({
		channelConfig: cfg.channels?.signal,
		accounts: cfg.channels?.signal?.accounts,
		accountId
	});
}
function resolveSignalAccount(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultSignalAccountId(params.cfg));
	const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
	const merged = mergeSignalAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const host = normalizeOptionalString(merged.httpHost) ?? "127.0.0.1";
	const port = merged.httpPort ?? 8080;
	const baseUrl = normalizeOptionalString(merged.httpUrl) ?? `http://${host}:${port}`;
	const configured = Boolean(normalizeOptionalString(merged.account) || normalizeOptionalString(merged.httpUrl) || normalizeOptionalString(merged.cliPath) || normalizeOptionalString(merged.httpHost) || typeof merged.httpPort === "number" || typeof merged.autoStart === "boolean");
	return {
		accountId,
		enabled,
		name: normalizeOptionalString(merged.name),
		baseUrl,
		configured,
		config: merged
	};
}
function listEnabledSignalAccounts(cfg) {
	return listSignalAccountIds(cfg).map((accountId) => resolveSignalAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
export { resolveSignalAccount as i, listSignalAccountIds as n, resolveDefaultSignalAccountId as r, listEnabledSignalAccounts as t };
