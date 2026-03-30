import { Zt as resolveOAuthDir, _t as info, kt as getChildLogger, st as resolveUserPath, tt as jidToE164, v as defaultRuntime, wt as success } from "./entry.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { h as normalizeAccountId, m as DEFAULT_ACCOUNT_ID } from "./session-key-qmb11-mH.js";
import { t as resolveAccountEntry } from "./account-lookup-DndUerpe.js";
import path from "node:path";
import fs from "node:fs";
import fs$1 from "node:fs/promises";

//#region src/channels/plugins/account-helpers.ts
function createAccountListHelpers(channelKey) {
	function listConfiguredAccountIds(cfg) {
		const accounts = (cfg.channels?.[channelKey])?.accounts;
		if (!accounts || typeof accounts !== "object") return [];
		return Object.keys(accounts).filter(Boolean);
	}
	function listAccountIds(cfg) {
		const ids = listConfiguredAccountIds(cfg);
		if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
		return ids.toSorted((a, b) => a.localeCompare(b));
	}
	function resolveDefaultAccountId(cfg) {
		const ids = listAccountIds(cfg);
		if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
		return ids[0] ?? DEFAULT_ACCOUNT_ID;
	}
	return {
		listConfiguredAccountIds,
		listAccountIds,
		resolveDefaultAccountId
	};
}

//#endregion
//#region src/web/auth-store.ts
function resolveDefaultWebAuthDir() {
	return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}
const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();
function resolveWebCredsPath(authDir) {
	return path.join(authDir, "creds.json");
}
function resolveWebCredsBackupPath(authDir) {
	return path.join(authDir, "creds.json.bak");
}
function hasWebCredsSync(authDir) {
	try {
		const stats = fs.statSync(resolveWebCredsPath(authDir));
		return stats.isFile() && stats.size > 1;
	} catch {
		return false;
	}
}
function readCredsJsonRaw(filePath) {
	try {
		if (!fs.existsSync(filePath)) return null;
		const stats = fs.statSync(filePath);
		if (!stats.isFile() || stats.size <= 1) return null;
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}
function maybeRestoreCredsFromBackup(authDir) {
	const logger = getChildLogger({ module: "web-session" });
	try {
		const credsPath = resolveWebCredsPath(authDir);
		const backupPath = resolveWebCredsBackupPath(authDir);
		const raw = readCredsJsonRaw(credsPath);
		if (raw) {
			JSON.parse(raw);
			return;
		}
		const backupRaw = readCredsJsonRaw(backupPath);
		if (!backupRaw) return;
		JSON.parse(backupRaw);
		fs.copyFileSync(backupPath, credsPath);
		try {
			fs.chmodSync(credsPath, 384);
		} catch {}
		logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
	} catch {}
}
async function webAuthExists(authDir = resolveDefaultWebAuthDir()) {
	const resolvedAuthDir = resolveUserPath(authDir);
	maybeRestoreCredsFromBackup(resolvedAuthDir);
	const credsPath = resolveWebCredsPath(resolvedAuthDir);
	try {
		await fs$1.access(resolvedAuthDir);
	} catch {
		return false;
	}
	try {
		const stats = await fs$1.stat(credsPath);
		if (!stats.isFile() || stats.size <= 1) return false;
		const raw = await fs$1.readFile(credsPath, "utf-8");
		JSON.parse(raw);
		return true;
	} catch {
		return false;
	}
}
async function clearLegacyBaileysAuthState(authDir) {
	const entries = await fs$1.readdir(authDir, { withFileTypes: true });
	const shouldDelete = (name) => {
		if (name === "oauth.json") return false;
		if (name === "creds.json" || name === "creds.json.bak") return true;
		if (!name.endsWith(".json")) return false;
		return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
	};
	await Promise.all(entries.map(async (entry) => {
		if (!entry.isFile()) return;
		if (!shouldDelete(entry.name)) return;
		await fs$1.rm(path.join(authDir, entry.name), { force: true });
	}));
}
async function logoutWeb(params) {
	const runtime = params.runtime ?? defaultRuntime;
	const resolvedAuthDir = resolveUserPath(params.authDir ?? resolveDefaultWebAuthDir());
	if (!await webAuthExists(resolvedAuthDir)) {
		runtime.log(info("No WhatsApp Web session found; nothing to delete."));
		return false;
	}
	if (params.isLegacyAuthDir) await clearLegacyBaileysAuthState(resolvedAuthDir);
	else await fs$1.rm(resolvedAuthDir, {
		recursive: true,
		force: true
	});
	runtime.log(success("Cleared WhatsApp Web credentials."));
	return true;
}
function readWebSelfId(authDir = resolveDefaultWebAuthDir()) {
	try {
		const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
		if (!fs.existsSync(credsPath)) return {
			e164: null,
			jid: null
		};
		const raw = fs.readFileSync(credsPath, "utf-8");
		const jid = JSON.parse(raw)?.me?.id ?? null;
		return {
			e164: jid ? jidToE164(jid, { authDir }) : null,
			jid
		};
	} catch {
		return {
			e164: null,
			jid: null
		};
	}
}
/**
* Return the age (in milliseconds) of the cached WhatsApp web auth state, or null when missing.
* Helpful for heartbeats/observability to spot stale credentials.
*/
function getWebAuthAgeMs(authDir = resolveDefaultWebAuthDir()) {
	try {
		const stats = fs.statSync(resolveWebCredsPath(resolveUserPath(authDir)));
		return Date.now() - stats.mtimeMs;
	} catch {
		return null;
	}
}
function logWebSelfId(authDir = resolveDefaultWebAuthDir(), runtime = defaultRuntime, includeChannelPrefix = false) {
	const { e164, jid } = readWebSelfId(authDir);
	const details = e164 || jid ? `${e164 ?? "unknown"}${jid ? ` (jid ${jid})` : ""}` : "unknown";
	const prefix = includeChannelPrefix ? "Web Channel: " : "";
	runtime.log(info(`${prefix}${details}`));
}
async function pickWebChannel(pref, authDir = resolveDefaultWebAuthDir()) {
	const choice = pref === "auto" ? "web" : pref;
	if (!await webAuthExists(authDir)) throw new Error(`No WhatsApp Web session found. Run \`${formatCliCommand("openclaw channels login --channel whatsapp --verbose")}\` to link.`);
	return choice;
}

//#endregion
//#region src/web/accounts.ts
const { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("whatsapp");
const listWhatsAppAccountIds = listAccountIds;
const resolveDefaultWhatsAppAccountId = resolveDefaultAccountId;
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
function resolveAccountConfig(cfg, accountId) {
	return resolveAccountEntry(cfg.channels?.whatsapp?.accounts, accountId);
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
	const accountId = params.accountId.trim() || DEFAULT_ACCOUNT_ID;
	const configured = resolveAccountConfig(params.cfg, accountId)?.authDir?.trim();
	if (configured) return {
		authDir: resolveUserPath(configured),
		isLegacy: false
	};
	const defaultDir = resolveDefaultAuthDir(accountId);
	if (accountId === DEFAULT_ACCOUNT_ID) {
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
	const rootCfg = params.cfg.channels?.whatsapp;
	const accountId = params.accountId?.trim() || resolveDefaultWhatsAppAccountId(params.cfg);
	const accountCfg = resolveAccountConfig(params.cfg, accountId);
	const enabled = accountCfg?.enabled !== false;
	const { authDir, isLegacy } = resolveWhatsAppAuthDir({
		cfg: params.cfg,
		accountId
	});
	return {
		accountId,
		name: accountCfg?.name?.trim() || void 0,
		enabled,
		sendReadReceipts: accountCfg?.sendReadReceipts ?? rootCfg?.sendReadReceipts ?? true,
		messagePrefix: accountCfg?.messagePrefix ?? rootCfg?.messagePrefix ?? params.cfg.messages?.messagePrefix,
		authDir,
		isLegacyAuthDir: isLegacy,
		selfChatMode: accountCfg?.selfChatMode ?? rootCfg?.selfChatMode,
		dmPolicy: accountCfg?.dmPolicy ?? rootCfg?.dmPolicy,
		allowFrom: accountCfg?.allowFrom ?? rootCfg?.allowFrom,
		groupAllowFrom: accountCfg?.groupAllowFrom ?? rootCfg?.groupAllowFrom,
		groupPolicy: accountCfg?.groupPolicy ?? rootCfg?.groupPolicy,
		textChunkLimit: accountCfg?.textChunkLimit ?? rootCfg?.textChunkLimit,
		chunkMode: accountCfg?.chunkMode ?? rootCfg?.chunkMode,
		mediaMaxMb: accountCfg?.mediaMaxMb ?? rootCfg?.mediaMaxMb,
		blockStreaming: accountCfg?.blockStreaming ?? rootCfg?.blockStreaming,
		ackReaction: accountCfg?.ackReaction ?? rootCfg?.ackReaction,
		groups: accountCfg?.groups ?? rootCfg?.groups,
		debounceMs: accountCfg?.debounceMs ?? rootCfg?.debounceMs
	};
}

//#endregion
export { webAuthExists as _, resolveWhatsAppAuthDir as a, logWebSelfId as c, pickWebChannel as d, readCredsJsonRaw as f, resolveWebCredsPath as g, resolveWebCredsBackupPath as h, resolveWhatsAppAccount as i, logoutWeb as l, resolveDefaultWebAuthDir as m, listWhatsAppAccountIds as n, WA_WEB_AUTH_DIR as o, readWebSelfId as p, resolveDefaultWhatsAppAccountId as r, getWebAuthAgeMs as s, hasAnyWhatsAppAuth as t, maybeRestoreCredsFromBackup as u, createAccountListHelpers as v };