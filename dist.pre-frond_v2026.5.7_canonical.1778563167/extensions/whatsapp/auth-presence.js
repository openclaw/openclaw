import { g as resolveOAuthDir } from "../../paths-Cnwfh6dH.js";
import { p as resolveUserPath } from "../../utils-CRkrr5e6.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "../../account-id-9_btbLFO.js";
import "../../account-resolution-DoHz7YIx.js";
import "../../state-paths-p3iplPQE.js";
import { t as hasWebCredsSync } from "../../creds-files-D5lv7UTl.js";
import fs from "node:fs";
import path from "node:path";
//#region extensions/whatsapp/auth-presence.ts
function addAccountAuthDirs(authDirs, accountId, authDir, accountsRoot, env) {
	authDirs.add(path.join(accountsRoot, normalizeAccountId(accountId)));
	const configuredAuthDir = authDir?.trim();
	if (configuredAuthDir) authDirs.add(resolveUserPath(configuredAuthDir, env));
}
function listWhatsAppAuthDirs(cfg, env = process.env) {
	const oauthDir = resolveOAuthDir(env);
	const accountsRoot = path.join(oauthDir, "whatsapp");
	const channel = cfg.channels?.whatsapp;
	const authDirs = new Set([oauthDir, path.join(accountsRoot, DEFAULT_ACCOUNT_ID)]);
	addAccountAuthDirs(authDirs, DEFAULT_ACCOUNT_ID, void 0, accountsRoot, env);
	if (channel?.defaultAccount?.trim()) addAccountAuthDirs(authDirs, channel.defaultAccount, channel.accounts?.[channel.defaultAccount]?.authDir, accountsRoot, env);
	const accounts = channel?.accounts;
	if (accounts) for (const [accountId, account] of Object.entries(accounts)) addAccountAuthDirs(authDirs, accountId, account?.authDir, accountsRoot, env);
	try {
		const entries = fs.readdirSync(accountsRoot, { withFileTypes: true });
		for (const entry of entries) if (entry.isDirectory()) authDirs.add(path.join(accountsRoot, entry.name));
	} catch {}
	return [...authDirs];
}
function hasAnyWhatsAppAuth(params, env = process.env) {
	return listWhatsAppAuthDirs(params && typeof params === "object" && "cfg" in params ? params.cfg : params, params && typeof params === "object" && "cfg" in params ? params.env ?? env : env).some((authDir) => hasWebCredsSync(authDir));
}
//#endregion
export { hasAnyWhatsAppAuth };
