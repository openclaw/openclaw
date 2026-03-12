import { Mt as toPinoLikeLogger, X as ensureDir, gt as danger, kt as getChildLogger, st as resolveUserPath, wt as success } from "./entry.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { r as VERSION } from "./env-vars-DPtuUD7z.js";
import { f as readCredsJsonRaw, g as resolveWebCredsPath, h as resolveWebCredsBackupPath, m as resolveDefaultWebAuthDir, u as maybeRestoreCredsFromBackup } from "./accounts-jTTYYc3C.js";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, makeWASocket, useMultiFileAuthState } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";

//#region src/web/session.ts
let credsSaveQueue = Promise.resolve();
function enqueueSaveCreds(authDir, saveCreds, logger) {
	credsSaveQueue = credsSaveQueue.then(() => safeSaveCreds(authDir, saveCreds, logger)).catch((err) => {
		logger.warn({ error: String(err) }, "WhatsApp creds save queue error");
	});
}
async function safeSaveCreds(authDir, saveCreds, logger) {
	try {
		const credsPath = resolveWebCredsPath(authDir);
		const backupPath = resolveWebCredsBackupPath(authDir);
		const raw = readCredsJsonRaw(credsPath);
		if (raw) try {
			JSON.parse(raw);
			fs.copyFileSync(credsPath, backupPath);
			try {
				fs.chmodSync(backupPath, 384);
			} catch {}
		} catch {}
	} catch {}
	try {
		await Promise.resolve(saveCreds());
		try {
			fs.chmodSync(resolveWebCredsPath(authDir), 384);
		} catch {}
	} catch (err) {
		logger.warn({ error: String(err) }, "failed saving WhatsApp creds");
	}
}
/**
* Create a Baileys socket backed by the multi-file auth store we keep on disk.
* Consumers can opt into QR printing for interactive login flows.
*/
async function createWaSocket(printQr, verbose, opts = {}) {
	const logger = toPinoLikeLogger(getChildLogger({ module: "baileys" }, { level: verbose ? "info" : "silent" }), verbose ? "info" : "silent");
	const authDir = resolveUserPath(opts.authDir ?? resolveDefaultWebAuthDir());
	await ensureDir(authDir);
	const sessionLogger = getChildLogger({ module: "web-session" });
	maybeRestoreCredsFromBackup(authDir);
	const { state, saveCreds } = await useMultiFileAuthState(authDir);
	const { version } = await fetchLatestBaileysVersion();
	const sock = makeWASocket({
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, logger)
		},
		version,
		logger,
		printQRInTerminal: false,
		browser: [
			"openclaw",
			"cli",
			VERSION
		],
		syncFullHistory: false,
		markOnlineOnConnect: false
	});
	sock.ev.on("creds.update", () => enqueueSaveCreds(authDir, saveCreds, sessionLogger));
	sock.ev.on("connection.update", (update) => {
		try {
			const { connection, lastDisconnect, qr } = update;
			if (qr) {
				opts.onQr?.(qr);
				if (printQr) {
					console.log("Scan this QR in WhatsApp (Linked Devices):");
					qrcode.generate(qr, { small: true });
				}
			}
			if (connection === "close") {
				if (getStatusCode(lastDisconnect?.error) === DisconnectReason.loggedOut) console.error(danger(`WhatsApp session logged out. Run: ${formatCliCommand("openclaw channels login")}`));
			}
			if (connection === "open" && verbose) console.log(success("WhatsApp Web connected."));
		} catch (err) {
			sessionLogger.error({ error: String(err) }, "connection.update handler error");
		}
	});
	if (sock.ws && typeof sock.ws.on === "function") sock.ws.on("error", (err) => {
		sessionLogger.error({ error: String(err) }, "WebSocket error");
	});
	return sock;
}
async function waitForWaConnection(sock) {
	return new Promise((resolve, reject) => {
		const evWithOff = sock.ev;
		const handler = (...args) => {
			const update = args[0] ?? {};
			if (update.connection === "open") {
				evWithOff.off?.("connection.update", handler);
				resolve();
			}
			if (update.connection === "close") {
				evWithOff.off?.("connection.update", handler);
				reject(update.lastDisconnect ?? /* @__PURE__ */ new Error("Connection closed"));
			}
		};
		sock.ev.on("connection.update", handler);
	});
}
function getStatusCode(err) {
	return err?.output?.statusCode ?? err?.status;
}
function safeStringify(value, limit = 800) {
	try {
		const seen = /* @__PURE__ */ new WeakSet();
		const raw = JSON.stringify(value, (_key, v) => {
			if (typeof v === "bigint") return v.toString();
			if (typeof v === "function") {
				const maybeName = v.name;
				return `[Function ${typeof maybeName === "string" && maybeName.length > 0 ? maybeName : "anonymous"}]`;
			}
			if (typeof v === "object" && v) {
				if (seen.has(v)) return "[Circular]";
				seen.add(v);
			}
			return v;
		}, 2);
		if (!raw) return String(value);
		return raw.length > limit ? `${raw.slice(0, limit)}…` : raw;
	} catch {
		return String(value);
	}
}
function extractBoomDetails(err) {
	if (!err || typeof err !== "object") return null;
	const output = err?.output;
	if (!output || typeof output !== "object") return null;
	const payload = output.payload;
	const statusCode = typeof output.statusCode === "number" ? output.statusCode : typeof payload?.statusCode === "number" ? payload.statusCode : void 0;
	const error = typeof payload?.error === "string" ? payload.error : void 0;
	const message = typeof payload?.message === "string" ? payload.message : void 0;
	if (!statusCode && !error && !message) return null;
	return {
		statusCode,
		error,
		message
	};
}
function formatError(err) {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (!err || typeof err !== "object") return String(err);
	const boom = extractBoomDetails(err) ?? extractBoomDetails(err?.error) ?? extractBoomDetails(err?.lastDisconnect?.error);
	const status = boom?.statusCode ?? getStatusCode(err);
	const code = err?.code;
	const codeText = typeof code === "string" || typeof code === "number" ? String(code) : void 0;
	const message = [
		boom?.message,
		typeof err?.message === "string" ? err.message : void 0,
		typeof err?.error?.message === "string" ? err.error?.message : void 0
	].filter((v) => Boolean(v && v.trim().length > 0))[0];
	const pieces = [];
	if (typeof status === "number") pieces.push(`status=${status}`);
	if (boom?.error) pieces.push(boom.error);
	if (message) pieces.push(message);
	if (codeText) pieces.push(`code=${codeText}`);
	if (pieces.length > 0) return pieces.join(" ");
	return safeStringify(err);
}

//#endregion
export { waitForWaConnection as i, formatError as n, getStatusCode as r, createWaSocket as t };