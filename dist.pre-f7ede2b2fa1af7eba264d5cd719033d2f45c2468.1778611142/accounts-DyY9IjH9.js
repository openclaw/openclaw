import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { g as resolveOAuthDir } from "./paths-Cnwfh6dH.js";
import { p as resolveUserPath } from "./utils-CRkrr5e6.js";
import { n as normalizeAccountId, t as DEFAULT_ACCOUNT_ID } from "./account-id-9_btbLFO.js";
import "./string-coerce-runtime-B-Wo_S-q.js";
import "./account-core-DQL1Bczt.js";
import "./state-paths-p3iplPQE.js";
import { t as resolveMergedWhatsAppAccountConfig } from "./account-config-CA7Wozy4.js";
import { n as listConfiguredAccountIds, r as resolveDefaultWhatsAppAccountId, t as listAccountIds } from "./account-ids-DjuAU7E6.js";
import { t as hasWebCredsSync } from "./creds-files-Bcp2362d.js";
import fs from "node:fs";
import path from "node:path";
//#region extensions/whatsapp/src/accounts.ts
const DEFAULT_WHATSAPP_MEDIA_MAX_MB = 50;
function listWhatsAppAuthDirs(cfg) {
	const oauthDir = resolveOAuthDir();
	const whatsappDir = path.join(oauthDir, "whatsapp");
	const authDirs = new Set([oauthDir, path.join(whatsappDir, DEFAULT_ACCOUNT_ID)]);
	const accountIds = listConfiguredAccountIds(cfg);
	for (const accountId of accountIds) authDirs.add(resolveWhatsAppAuthDir({
		cfg,
		accountId
	}).authDir);
	try {
		const entries = fs.readdirSync(whatsappDir, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			authDirs.add(path.join(whatsappDir, entry.name));
		}
	} catch {}
	return Array.from(authDirs);
}
function hasAnyWhatsAppAuth(cfg) {
	return listWhatsAppAuthDirs(cfg).some((authDir) => hasWebCredsSync(authDir));
}
function resolveDefaultAuthDir(accountId) {
	return path.join(resolveOAuthDir(), "whatsapp", normalizeAccountId(accountId));
}
function resolveLegacyAuthDir() {
	return resolveOAuthDir();
}
function legacyAuthExists(authDir) {
	try {
		return fs.existsSync(path.join(authDir, "creds.json"));
	} catch {
		return false;
	}
}
function resolveWhatsAppAuthDir(params) {
	const accountId = params.accountId.trim() || "default";
	const configured = resolveMergedWhatsAppAccountConfig({
		cfg: params.cfg,
		accountId
	})?.authDir?.trim();
	if (configured) return {
		authDir: resolveUserPath(configured),
		isLegacy: false
	};
	const defaultDir = resolveDefaultAuthDir(accountId);
	if (accountId === "default") {
		const legacyDir = resolveLegacyAuthDir();
		if (legacyAuthExists(legacyDir) && !legacyAuthExists(defaultDir)) return {
			authDir: legacyDir,
			isLegacy: true
		};
	}
	return {
		authDir: defaultDir,
		isLegacy: false
	};
}
function resolveWhatsAppAccount(params) {
	const merged = resolveMergedWhatsAppAccountConfig({
		cfg: params.cfg,
		accountId: params.accountId?.trim() || resolveDefaultWhatsAppAccountId(params.cfg)
	});
	const accountId = merged.accountId;
	const enabled = merged.enabled !== false;
	const { authDir, isLegacy } = resolveWhatsAppAuthDir({
		cfg: params.cfg,
		accountId
	});
	return {
		accountId,
		name: normalizeOptionalString(merged.name),
		enabled,
		sendReadReceipts: merged.sendReadReceipts ?? true,
		messagePrefix: merged.messagePrefix ?? params.cfg.messages?.messagePrefix,
		defaultTo: merged.defaultTo,
		authDir,
		isLegacyAuthDir: isLegacy,
		selfChatMode: merged.selfChatMode,
		dmPolicy: merged.dmPolicy,
		allowFrom: merged.allowFrom,
		groupAllowFrom: merged.groupAllowFrom,
		groupPolicy: merged.groupPolicy,
		historyLimit: merged.historyLimit,
		textChunkLimit: merged.textChunkLimit,
		chunkMode: merged.chunkMode,
		mediaMaxMb: merged.mediaMaxMb,
		blockStreaming: merged.blockStreaming,
		ackReaction: merged.ackReaction,
		reactionLevel: merged.reactionLevel,
		groups: merged.groups,
		direct: merged.direct,
		debounceMs: merged.debounceMs,
		replyToMode: merged.replyToMode
	};
}
function resolveWhatsAppMediaMaxBytes(account) {
	return (typeof account.mediaMaxMb === "number" && account.mediaMaxMb > 0 ? account.mediaMaxMb : 50) * 1024 * 1024;
}
function listEnabledWhatsAppAccounts(cfg) {
	return listAccountIds(cfg).map((accountId) => resolveWhatsAppAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
export { resolveWhatsAppAccount as a, listWhatsAppAuthDirs as i, hasAnyWhatsAppAuth as n, resolveWhatsAppAuthDir as o, listEnabledWhatsAppAccounts as r, resolveWhatsAppMediaMaxBytes as s, DEFAULT_WHATSAPP_MEDIA_MAX_MB as t };
