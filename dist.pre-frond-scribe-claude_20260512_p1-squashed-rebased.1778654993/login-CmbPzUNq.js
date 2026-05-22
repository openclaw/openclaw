import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { n as defaultRuntime } from "./runtime-E6YfuGL9.js";
import { o as success, t as danger } from "./globals-CsZphy1u.js";
import { r as logInfo } from "./logger-DN3suabW.js";
import { i as getRuntimeConfig } from "./io-D39r-SPY.js";
import "./runtime-env-UeKVf4aK.js";
import "./runtime-config-snapshot-DmShASTr.js";
import { t as renderQrTerminal } from "./qr-terminal-CmL6Tv6W.js";
import "./cli-runtime-86pjFQiV.js";
import "./logging-core-Chn8zC2Z.js";
import { a as resolveWhatsAppAccount } from "./accounts-Dsj3Roan.js";
import { y as restoreCredsFromBackupIfNeeded } from "./auth-store-DY6ch0lh.js";
import { i as resolveWhatsAppSocketTiming, t as createWaSocket } from "./session-Cyg_GxhD.js";
import { a as closeWaSocketSoon, o as waitForWhatsAppLoginResult } from "./connection-controller-BiayURkJ.js";
//#region extensions/whatsapp/src/login.ts
async function loginWeb(verbose, waitForConnection, runtime = defaultRuntime, accountId) {
	const cfg = getRuntimeConfig();
	const account = resolveWhatsAppAccount({
		cfg,
		accountId
	});
	const socketTiming = resolveWhatsAppSocketTiming(cfg);
	const restoredFromBackup = await restoreCredsFromBackupIfNeeded(account.authDir);
	const onQr = (qr) => {
		runtime.log("Open the WhatsApp app, go to Linked Devices, then scan this QR:");
		renderQrTerminal(qr).then((output) => {
			runtime.log(output.endsWith("\n") ? output.slice(0, -1) : output);
		}).catch((err) => {
			runtime.error(`failed rendering WhatsApp QR: ${String(err)}`);
		});
	};
	let sock = await createWaSocket(false, verbose, {
		authDir: account.authDir,
		...socketTiming,
		onQr
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
			onQr,
			onSocketReplaced: (replacementSock) => {
				sock = replacementSock;
			}
		});
		if (result.outcome === "connected") {
			runtime.log(success(result.restarted ? "✅ Linked after restart; web session ready." : restoredFromBackup ? "✅ Recovered from creds.json.bak; web session ready." : "✅ Linked! Credentials saved for future sends."));
			return;
		}
		if (result.outcome === "logged-out") {
			runtime.error(danger(`WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`));
			throw new Error("Session logged out; cache cleared. Re-run login.", { cause: result.error });
		}
		runtime.error(danger(`WhatsApp Web connection ended before fully opening. ${result.message}`));
		throw new Error(result.message, { cause: result.error });
	} finally {
		closeWaSocketSoon(sock);
	}
}
//#endregion
export { loginWeb as t };
