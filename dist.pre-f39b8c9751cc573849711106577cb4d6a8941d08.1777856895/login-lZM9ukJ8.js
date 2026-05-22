import { t as formatCliCommand } from "./command-format-DXo6xcsW.js";
import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { o as success, t as danger } from "./globals-Dn_zSD2h.js";
import { r as logInfo } from "./logger-B-q5m71x.js";
import { i as getRuntimeConfig } from "./io-DJ0qH7nz.js";
import "./text-runtime-CFBwIeh_.js";
import "./runtime-env-PjQ_OX8O.js";
import "./runtime-config-snapshot-Cth5ZQPA.js";
import "./cli-runtime-VEbdxmIf.js";
import { a as resolveWhatsAppAccount } from "./accounts-TWB7TL7V.js";
import { y as restoreCredsFromBackupIfNeeded } from "./auth-store-QQqJxmt6.js";
import { a as waitForWhatsAppLoginResult, i as closeWaSocketSoon, l as resolveWhatsAppSocketTiming, o as createWaSocket } from "./connection-controller-D7TjQz_g.js";
//#region extensions/whatsapp/src/login.ts
async function loginWeb(verbose, waitForConnection, runtime = defaultRuntime, accountId) {
	const cfg = getRuntimeConfig();
	const account = resolveWhatsAppAccount({
		cfg,
		accountId
	});
	const socketTiming = resolveWhatsAppSocketTiming(cfg);
	const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir);
	let sock = await createWaSocket(true, verbose, {
		authDir: account.authDir,
		...socketTiming
	});
	logInfo("Waiting for WhatsApp connection...", runtime);
	try {
		const result = await waitForWhatsAppLoginResult({
			sock,
			authDir: account.authDir,
			isLegacyAuthDir: account.isLegacyAuthDir,
			verbose,
			runtime,
			waitForConnection,
			socketTiming,
			onSocketReplaced: (replacementSock) => {
				sock = replacementSock;
			}
		});
		if (result.outcome === "connected") {
			console.log(success(result.restarted ? "✅ Linked after restart; web session ready." : restoredFromBackup ? "✅ Recovered from creds.json.bak; web session ready." : "✅ Linked! Credentials saved for future sends."));
			return;
		}
		if (result.outcome === "logged-out") {
			console.error(danger(`WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`));
			throw new Error("Session logged out; cache cleared. Re-run login.", { cause: result.error });
		}
		console.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
		throw new Error(result.message, { cause: result.error });
	} finally {
		closeWaSocketSoon(sock);
	}
}
//#endregion
export { loginWeb as t };
