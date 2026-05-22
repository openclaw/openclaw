import { g as resolveOAuthDir } from "../../paths-C1_Y0cDn.js";
import { t as formatCliCommand } from "../../command-format-ut6bcRZg.js";
import { p as resolveUserPath } from "../../utils-D5swhEXt.js";
import { t as DEFAULT_ACCOUNT_ID } from "../../account-id-Bj7l9NI7.js";
import { n as defaultRuntime } from "../../runtime-bzt9CHmD.js";
import { i as getChildLogger } from "../../logger-CQ0p51p4.js";
import { n as info, o as success } from "../../globals-BHVmraBM.js";
import "../../routing-DfF4_bqH.js";
import "../../runtime-env-DyZrKYOx.js";
import "../../cli-runtime-DS1cowgP.js";
import "../../state-paths-7tNathRX.js";
import { n as resolveWebCredsBackupPath, r as resolveWebCredsPath } from "./creds-files-CSn15Kgm.js";
import "./text-runtime-0Q2C6SWP.js";
import { c as resolveComparableIdentity } from "./identity-BFmiJOJG.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
//#region extensions/whatsapp/src/creds-persistence.ts
const CREDS_FILE_MODE = 384;
const CREDS_SAVE_FLUSH_TIMEOUT_MS = 15e3;
const credsSaveQueues = /* @__PURE__ */ new Map();
async function stringifyCreds(creds) {
	const { BufferJSON } = await import("./session.runtime-BOQCmaH2.js");
	return JSON.stringify(creds, BufferJSON.replacer);
}
async function syncDirectory(dirPath) {
	let handle;
	try {
		handle = await fs$1.open(dirPath, "r");
		await handle.sync();
	} catch {} finally {
		await handle?.close().catch(() => {});
	}
}
async function writeCredsJsonAtomically(authDir, creds) {
	const credsPath = resolveWebCredsPath(authDir);
	const tempPath = path.join(authDir, `.creds.${process.pid}.${randomUUID()}.tmp`);
	const json = await stringifyCreds(creds);
	let handle;
	try {
		handle = await fs$1.open(tempPath, "w", CREDS_FILE_MODE);
		await handle.writeFile(json, { encoding: "utf-8" });
		await handle.sync();
		await handle.close();
		handle = void 0;
		await fs$1.rename(tempPath, credsPath);
		await fs$1.chmod(credsPath, CREDS_FILE_MODE).catch(() => {});
		await syncDirectory(path.dirname(credsPath));
	} catch (error) {
		await handle?.close().catch(() => {});
		await fs$1.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}
function enqueueCredsSave(authDir, saveCreds, onError) {
	const next = (credsSaveQueues.get(authDir) ?? Promise.resolve()).then(() => saveCreds()).catch((error) => {
		onError(error);
	}).finally(() => {
		if (credsSaveQueues.get(authDir) === next) credsSaveQueues.delete(authDir);
	});
	credsSaveQueues.set(authDir, next);
}
function waitForCredsSaveQueue(authDir) {
	if (authDir) return credsSaveQueues.get(authDir) ?? Promise.resolve();
	return Promise.all(credsSaveQueues.values()).then(() => {});
}
async function waitForCredsSaveQueueWithTimeout(authDir, timeoutMs = CREDS_SAVE_FLUSH_TIMEOUT_MS) {
	let flushTimeout;
	return await Promise.race([waitForCredsSaveQueue(authDir).then(() => "drained"), new Promise((resolve) => {
		flushTimeout = setTimeout(() => resolve("timed_out"), timeoutMs);
	})]).finally(() => {
		if (flushTimeout) clearTimeout(flushTimeout);
	});
}
//#endregion
//#region extensions/whatsapp/src/auth-store.ts
const WHATSAPP_AUTH_UNSTABLE_CODE = "whatsapp-auth-unstable";
const authStoreLogger = getChildLogger({ module: "web-auth-store" });
const emptyWebSelfId = () => ({
	e164: null,
	jid: null,
	lid: null
});
var WhatsAppAuthUnstableError = class extends Error {
	constructor(message = "WhatsApp auth state is still stabilizing; retry shortly.") {
		super(message);
		this.code = WHATSAPP_AUTH_UNSTABLE_CODE;
		this.name = "WhatsAppAuthUnstableError";
	}
};
function resolveDefaultWebAuthDir() {
	return path.join(resolveOAuthDir(), "whatsapp", DEFAULT_ACCOUNT_ID);
}
const WA_WEB_AUTH_DIR = resolveDefaultWebAuthDir();
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
async function waitForWebAuthBarrier(authDir, context) {
	const result = await waitForCredsSaveQueueWithTimeout(authDir);
	if (result === "timed_out") authStoreLogger.warn({
		authDir,
		context
	}, "timed out waiting for queued WhatsApp creds save before auth read");
	return result;
}
async function restoreCredsFromBackupIfNeeded(authDir) {
	const logger = getChildLogger({ module: "web-session" });
	let tempRestorePath = null;
	try {
		const credsPath = resolveWebCredsPath(authDir);
		const backupPath = resolveWebCredsBackupPath(authDir);
		const raw = readCredsJsonRaw(credsPath);
		if (raw) {
			JSON.parse(raw);
			return false;
		}
		const backupRaw = readCredsJsonRaw(backupPath);
		if (!backupRaw) return false;
		if (!(await fs$1.lstat(backupPath).catch(() => null))?.isFile()) return false;
		JSON.parse(backupRaw);
		tempRestorePath = path.join(authDir, `.creds.restore-${randomUUID()}.tmp`);
		await fs$1.writeFile(tempRestorePath, backupRaw, {
			encoding: "utf-8",
			mode: 384,
			flag: "wx"
		});
		await fs$1.rename(tempRestorePath, credsPath);
		tempRestorePath = null;
		logger.warn({ credsPath }, "restored corrupted WhatsApp creds.json from backup");
		return true;
	} catch {} finally {
		if (tempRestorePath) await fs$1.rm(tempRestorePath, { force: true }).catch(() => {});
	}
	return false;
}
async function webAuthExists(authDir = resolveDefaultWebAuthDir()) {
	const resolvedAuthDir = resolveUserPath(authDir);
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
function resolveWebAuthState(params) {
	if (params.barrierResult === "timed_out") return "unstable";
	return params.linked ? "linked" : "not-linked";
}
async function readWebAuthStateCore(authDir, context) {
	const resolvedAuthDir = resolveUserPath(authDir);
	const barrierResult = await waitForWebAuthBarrier(resolvedAuthDir, context);
	const linked = await webAuthExists(resolvedAuthDir);
	return {
		authDir: resolvedAuthDir,
		linked,
		state: resolveWebAuthState({
			linked,
			barrierResult
		})
	};
}
function formatWhatsAppWebAuthStatusState(state) {
	switch (state) {
		case "linked": return "linked";
		case "not-linked": return "not linked";
		case "unstable": return "auth stabilizing";
	}
	return state;
}
async function readWebAuthState(authDir = resolveDefaultWebAuthDir()) {
	return (await readWebAuthStateCore(authDir, "readWebAuthState")).state;
}
async function readWebAuthSnapshot(authDir = resolveDefaultWebAuthDir()) {
	const auth = await readWebAuthStateCore(authDir, "readWebAuthSnapshot");
	return {
		state: auth.state,
		authAgeMs: auth.state === "linked" ? getWebAuthAgeMs(auth.authDir) : null,
		selfId: auth.state === "linked" ? readWebSelfId(auth.authDir) : emptyWebSelfId()
	};
}
async function readWebAuthExistsBestEffort(authDir = resolveDefaultWebAuthDir()) {
	const state = await readWebAuthState(authDir);
	return {
		exists: state === "linked",
		timedOut: state === "unstable"
	};
}
async function readWebAuthExistsForDecision(authDir = resolveDefaultWebAuthDir()) {
	const state = await readWebAuthState(authDir);
	if (state === "unstable") return { outcome: "unstable" };
	return {
		outcome: "stable",
		exists: state === "linked"
	};
}
async function readWebAuthSnapshotBestEffort(authDir = resolveDefaultWebAuthDir()) {
	const snapshot = await readWebAuthSnapshot(authDir);
	return {
		linked: snapshot.state === "linked",
		timedOut: snapshot.state === "unstable",
		authAgeMs: snapshot.authAgeMs,
		selfId: snapshot.selfId
	};
}
function isBaileysAuthFileName(name) {
	if (name === "oauth.json") return false;
	if (name === "creds.json" || name === "creds.json.bak") return true;
	if (!name.endsWith(".json")) return false;
	return /^(app-state-sync|session|sender-key|pre-key)-/.test(name);
}
async function clearBaileysAuthFiles(authDir) {
	const rootStats = await fs$1.lstat(authDir).catch(() => null);
	if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) return;
	const entries = await fs$1.readdir(authDir, { withFileTypes: true });
	await Promise.all(entries.map(async (entry) => {
		if (!entry.isFile()) return;
		if (!isBaileysAuthFileName(entry.name)) return;
		await fs$1.rm(path.join(authDir, entry.name), { force: true });
	}));
}
async function shouldClearOnLogout(authDir, isLegacyAuthDir) {
	try {
		const stats = await fs$1.lstat(authDir);
		if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
		if (isLegacyAuthDir) return (await fs$1.readdir(authDir, { withFileTypes: true })).some((entry) => {
			if (!entry.isFile()) return false;
			return isBaileysAuthFileName(entry.name);
		});
		if ((await fs$1.lstat(resolveWebCredsPath(authDir)).catch(() => null))?.isFile()) return true;
		return (await fs$1.lstat(resolveWebCredsBackupPath(authDir)).catch(() => null))?.isFile() === true;
	} catch (error) {
		const codeValue = error && typeof error === "object" && "code" in error ? error.code : void 0;
		return (typeof codeValue === "string" ? codeValue : "") !== "ENOENT";
	}
}
function isPathInsideDirectory(baseDir, targetPath) {
	const relativePath = path.relative(baseDir, targetPath);
	return relativePath !== "" && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
async function pathHasSymlinkComponent(baseDir, targetPath) {
	const relativePath = path.relative(baseDir, targetPath);
	let currentPath = baseDir;
	for (const segment of relativePath.split(path.sep)) {
		currentPath = path.join(currentPath, segment);
		const stats = await fs$1.lstat(currentPath).catch(() => null);
		if (!stats || stats.isSymbolicLink()) return true;
	}
	return false;
}
async function isLegacyWebAuthDir(authDir) {
	const legacyAuthDir = path.resolve(resolveOAuthDir());
	const resolvedAuthDir = path.resolve(authDir);
	if (resolvedAuthDir !== legacyAuthDir) return false;
	const stats = await fs$1.lstat(resolvedAuthDir).catch(() => null);
	return stats?.isDirectory() === true && !stats.isSymbolicLink();
}
async function classifyWebAuthDirOwnership(authDir) {
	const whatsappAuthBase = path.resolve(resolveOAuthDir(), "whatsapp");
	const resolvedAuthDir = path.resolve(authDir);
	if (!isPathInsideDirectory(whatsappAuthBase, resolvedAuthDir)) return { kind: "external" };
	const [baseRealPath, authDirRealPath] = await Promise.all([fs$1.realpath(whatsappAuthBase).catch(() => null), fs$1.realpath(resolvedAuthDir).catch(() => null)]);
	if (!baseRealPath || !authDirRealPath) return { kind: "unsafe-owned" };
	if (!isPathInsideDirectory(baseRealPath, authDirRealPath)) return { kind: "unsafe-owned" };
	if (await pathHasSymlinkComponent(whatsappAuthBase, resolvedAuthDir)) return { kind: "unsafe-owned" };
	return {
		kind: "owned",
		authDir: resolvedAuthDir
	};
}
async function logoutWeb(params) {
	const runtime = params.runtime ?? defaultRuntime;
	const resolvedAuthDir = resolveUserPath(params.authDir ?? resolveDefaultWebAuthDir());
	if (await waitForWebAuthBarrier(resolvedAuthDir, "logoutWeb") === "timed_out") runtime.log(info("WhatsApp auth state is still stabilizing; clearing cached credentials anyway."));
	if (!await shouldClearOnLogout(resolvedAuthDir, Boolean(params.isLegacyAuthDir))) {
		runtime.log(info("No WhatsApp Web session found; nothing to delete."));
		return false;
	}
	if (params.isLegacyAuthDir) {
		if (!await isLegacyWebAuthDir(resolvedAuthDir)) {
			runtime.log(info("Skipped WhatsApp Web credential cleanup outside the managed legacy auth directory."));
			return false;
		}
		await clearBaileysAuthFiles(resolvedAuthDir);
	} else {
		const ownership = await classifyWebAuthDirOwnership(resolvedAuthDir);
		if (ownership.kind === "owned") await fs$1.rm(ownership.authDir, {
			recursive: true,
			force: true
		});
		else if (ownership.kind === "unsafe-owned") {
			runtime.log(info("Skipped WhatsApp Web credential cleanup because the auth directory crosses a symlink boundary."));
			return false;
		} else {
			runtime.log(info("Skipped WhatsApp Web credential cleanup outside the managed auth directory."));
			return false;
		}
	}
	runtime.log(success("Cleared WhatsApp Web credentials."));
	return true;
}
function readWebSelfId(authDir = resolveDefaultWebAuthDir()) {
	try {
		const credsPath = resolveWebCredsPath(resolveUserPath(authDir));
		if (!fs.existsSync(credsPath)) return emptyWebSelfId();
		const raw = fs.readFileSync(credsPath, "utf-8");
		const parsed = JSON.parse(raw);
		const identity = resolveComparableIdentity({
			jid: parsed?.me?.id ?? null,
			lid: parsed?.me?.lid ?? null
		}, authDir);
		return {
			e164: identity.e164 ?? null,
			jid: identity.jid ?? null,
			lid: identity.lid ?? null
		};
	} catch {
		return emptyWebSelfId();
	}
}
async function readWebSelfIdentity(authDir = resolveDefaultWebAuthDir(), fallback) {
	const resolvedAuthDir = resolveUserPath(authDir);
	try {
		const raw = await fs$1.readFile(resolveWebCredsPath(resolvedAuthDir), "utf-8");
		const parsed = JSON.parse(raw);
		return resolveComparableIdentity({
			jid: parsed?.me?.id ?? null,
			lid: parsed?.me?.lid ?? null
		}, resolvedAuthDir);
	} catch {
		return resolveComparableIdentity({
			jid: fallback?.id ?? null,
			lid: fallback?.lid ?? null
		}, resolvedAuthDir);
	}
}
async function readWebSelfIdentityForDecision(authDir = resolveDefaultWebAuthDir(), fallback) {
	const resolvedAuthDir = resolveUserPath(authDir);
	if (await waitForWebAuthBarrier(resolvedAuthDir, "readWebSelfIdentityForDecision") === "timed_out") return { outcome: "unstable" };
	return {
		outcome: "stable",
		identity: await readWebSelfIdentity(resolvedAuthDir, fallback)
	};
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
	const { e164, jid, lid } = readWebSelfId(authDir);
	const parts = [jid ? `jid ${jid}` : null, lid ? `lid ${lid}` : null].filter((value) => Boolean(value));
	const details = e164 || parts.length > 0 ? `${e164 ?? "unknown"}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}` : "unknown";
	const prefix = includeChannelPrefix ? "Web Channel: " : "";
	runtime.log(info(`${prefix}${details}`));
}
async function pickWebChannel(pref, authDir = resolveDefaultWebAuthDir()) {
	const choice = pref === "auto" ? "web" : pref;
	const auth = await readWebAuthExistsForDecision(authDir);
	if (auth.outcome === "unstable") throw new WhatsAppAuthUnstableError();
	if (!auth.exists) throw new Error(`No WhatsApp Web session found. Run \`${formatCliCommand("openclaw channels login --channel whatsapp --verbose")}\` to link.`);
	return choice;
}
//#endregion
export { waitForCredsSaveQueueWithTimeout as C, waitForCredsSaveQueue as S, readWebSelfIdentityForDecision as _, getWebAuthAgeMs as a, webAuthExists as b, pickWebChannel as c, readWebAuthExistsForDecision as d, readWebAuthSnapshot as f, readWebSelfIdentity as g, readWebSelfId as h, formatWhatsAppWebAuthStatusState as i, readCredsJsonRaw as l, readWebAuthState as m, WHATSAPP_AUTH_UNSTABLE_CODE as n, logWebSelfId as o, readWebAuthSnapshotBestEffort as p, WhatsAppAuthUnstableError as r, logoutWeb as s, WA_WEB_AUTH_DIR as t, readWebAuthExistsBestEffort as u, resolveDefaultWebAuthDir as v, writeCredsJsonAtomically as w, enqueueCredsSave as x, restoreCredsFromBackupIfNeeded as y };
