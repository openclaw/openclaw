import { d as success, n as info, t as danger } from "./globals-DqM7Q4km.js";
import { d as defaultRuntime } from "./subsystem-BXiL6bA6.js";
import { z as loadConfig } from "./auth-profiles-C39jSzPb.js";
import { t as formatCliCommand } from "./command-format-CLEQe4bk.js";
import { r as logInfo } from "./logger-hujp-3PD.js";
import { i as resolveWhatsAppAccount, l as logoutWeb } from "./accounts-C8pI_u-9.js";
import { i as waitForWaConnection, n as formatError, t as createWaSocket } from "./session-DurDm65w.js";
import { DisconnectReason } from "@whiskeysockets/baileys";

//#region src/web/login.ts
async function loginWeb(verbose, waitForConnection, runtime = defaultRuntime, accountId) {
	const wait = waitForConnection ?? waitForWaConnection;
	const account = resolveWhatsAppAccount({
		cfg: loadConfig(),
		accountId
	});
	const sock = await createWaSocket(true, verbose, { authDir: account.authDir });
	logInfo("Waiting for WhatsApp connection...", runtime);
	try {
		await wait(sock);
		console.log(success("✅ Linked! Credentials saved for future sends."));
	} catch (err) {
		const code = err?.error?.output?.statusCode ?? err?.output?.statusCode;
		if (code === 515) {
			console.log(info("WhatsApp asked for a restart after pairing (code 515); creds are saved. Restarting connection once…"));
			try {
				sock.ws?.close();
			} catch {}
			const retry = await createWaSocket(false, verbose, { authDir: account.authDir });
			try {
				await wait(retry);
				console.log(success("✅ Linked after restart; web session ready."));
				return;
			} finally {
				setTimeout(() => retry.ws?.close(), 500);
			}
		}
		if (code === DisconnectReason.loggedOut) {
			await logoutWeb({
				authDir: account.authDir,
				isLegacyAuthDir: account.isLegacyAuthDir,
				runtime
			});
			console.error(danger(`WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`));
			throw new Error("Session logged out; cache cleared. Re-run login.", { cause: err });
		}
		const formatted = formatError(err);
		console.error(danger(`WhatsApp Web connection ended before fully opening. ${formatted}`));
		throw new Error(formatted, { cause: err });
	} finally {
		setTimeout(() => {
			try {
				sock.ws?.close();
			} catch {}
		}, 500);
	}
}

//#endregion
export { loginWeb as t };