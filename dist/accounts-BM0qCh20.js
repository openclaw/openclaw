import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { c as resolveMergedAccountConfig, t as createAccountListHelpers } from "./account-helpers-BEXOONiv.js";
import "./account-resolution-Dy8RKAMt.js";
//#region extensions/zalouser/src/accounts.ts
let zalouserAccountsRuntimePromise;
async function loadZalouserAccountsRuntime() {
	zalouserAccountsRuntimePromise ??= import("./accounts.runtime.js");
	return await zalouserAccountsRuntimePromise;
}
const { listAccountIds: listZalouserAccountIds, resolveDefaultAccountId: resolveDefaultZalouserAccountId } = createAccountListHelpers("zalouser", { implicitDefaultAccount: {
	channelKeys: ["profile"],
	envVars: ["ZALOUSER_PROFILE", "ZCA_PROFILE"]
} });
function mergeZalouserAccountConfig(cfg, accountId) {
	const merged = resolveMergedAccountConfig({
		channelConfig: cfg.channels?.zalouser,
		accounts: (cfg.channels?.zalouser)?.accounts,
		accountId,
		omitKeys: ["defaultAccount"]
	});
	return {
		...merged,
		groupPolicy: merged.groupPolicy ?? "allowlist"
	};
}
function resolveProfile(config, accountId) {
	if (config.profile?.trim()) return config.profile.trim();
	if (process.env.ZALOUSER_PROFILE?.trim()) return process.env.ZALOUSER_PROFILE.trim();
	if (process.env.ZCA_PROFILE?.trim()) return process.env.ZCA_PROFILE.trim();
	if (accountId !== "default") return accountId;
	return "default";
}
function resolveZalouserAccountBase(params) {
	const accountId = normalizeAccountId(params.accountId ?? resolveDefaultZalouserAccountId(params.cfg));
	const baseEnabled = (params.cfg.channels?.zalouser)?.enabled !== false;
	const merged = mergeZalouserAccountConfig(params.cfg, accountId);
	return {
		accountId,
		enabled: baseEnabled && merged.enabled !== false,
		merged,
		profile: resolveProfile(merged, accountId)
	};
}
function resolveZalouserAccountSync(params) {
	const { accountId, enabled, merged, profile } = resolveZalouserAccountBase(params);
	return {
		accountId,
		name: normalizeOptionalString(merged.name),
		enabled,
		profile,
		authenticated: false,
		config: merged
	};
}
async function getZcaUserInfo(profile) {
	const info = await (await loadZalouserAccountsRuntime()).getZaloUserInfo(profile);
	if (!info) return null;
	return {
		userId: info.userId,
		displayName: info.displayName
	};
}
async function checkZcaAuthenticated(profile) {
	return await (await loadZalouserAccountsRuntime()).checkZaloAuthenticated(profile);
}
//#endregion
export { resolveZalouserAccountSync as a, resolveDefaultZalouserAccountId as i, getZcaUserInfo as n, listZalouserAccountIds as r, checkZcaAuthenticated as t };
