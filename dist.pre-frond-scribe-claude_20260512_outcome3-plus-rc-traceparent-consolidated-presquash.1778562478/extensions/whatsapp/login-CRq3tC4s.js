import { t as formatCliCommand } from "../../command-format-ut6bcRZg.js";
import { n as defaultRuntime } from "../../runtime-bzt9CHmD.js";
import { o as success, t as danger } from "../../globals-BHVmraBM.js";
import { r as logInfo } from "../../logger-M-PaInRe.js";
import { i as getRuntimeConfig } from "../../io-C04VWQdx.js";
import "../../text-runtime-FOsx_CPC.js";
import "../../runtime-env-DyZrKYOx.js";
import "../../runtime-config-snapshot-CGsgy2BE.js";
import { t as renderQrTerminal } from "../../qr-terminal-0-10fP_I.js";
import "../../cli-runtime-DS1cowgP.js";
import { a as resolveWhatsAppAccount } from "./accounts-Dk91WUCl.js";
import { y as restoreCredsFromBackupIfNeeded } from "./auth-store-Fiqvs0hU.js";
import { a as waitForWhatsAppLoginResult, i as closeWaSocketSoon, l as resolveWhatsAppSocketTiming, o as createWaSocket } from "./connection-controller-DJeSuB4P.js";
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
		renderQrTerminal(qr, { small: true }).then((output) => {
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
