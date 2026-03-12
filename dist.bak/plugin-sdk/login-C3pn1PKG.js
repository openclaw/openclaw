import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { i as resolveWhatsAppAccount, l as logoutWeb } from "./accounts-B5SFFfMD.js";
import { n as loadConfig } from "./config-DunvA-uZ.js";
import { Q as info, Z as danger, i as defaultRuntime, rt as success } from "./subsystem-B0uKDnzH.js";
import { t as formatCliCommand } from "./command-format-BVkj1PMu.js";
import { j as logInfo } from "./agent-scope-DgbjWdYv.js";
import { i as waitForWaConnection, n as formatError, t as createWaSocket } from "./session-DISBcWmE.js";
import { DisconnectReason } from "@whiskeysockets/baileys";

//#region src/web/login.ts
var login_exports = /* @__PURE__ */ __exportAll({ loginWeb: () => loginWeb });
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
export { login_exports as n, loginWeb as t };