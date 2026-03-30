import { DisconnectReason } from "@whiskeysockets/baileys";
import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
	danger,
	defaultRuntime,
	info,
	type RuntimeEnv,
	success,
} from "openclaw/plugin-sdk/runtime-env";
import { logInfo } from "openclaw/plugin-sdk/text-runtime";
import { resolveWhatsAppAccount } from "./accounts.js";
import {
	createWaSocket,
	formatError,
	getStatusCode,
	logoutWeb,
	waitForCredsSaveQueueWithTimeout,
	waitForWaConnection,
} from "./session.js";

const LOGGED_OUT_STATUS = DisconnectReason?.loggedOut ?? 401;

export async function loginWeb(
	verbose: boolean,
	waitForConnection?: typeof waitForWaConnection,
	runtime: RuntimeEnv = defaultRuntime,
	accountId?: string,
) {
	const wait = waitForConnection ?? waitForWaConnection;
	const cfg = loadConfig();
	const account = resolveWhatsAppAccount({ cfg, accountId });
	const sock = await createWaSocket(true, verbose, {
		authDir: account.authDir,
	});
	logInfo("Waiting for WhatsApp connection...", runtime);
	try {
		await wait(sock);
		console.log(success("✅ Linked! Credentials saved for future sends."));
	} catch (err) {
		const code = getStatusCode(err);
		if (code === 515) {
			console.log(
				info(
					"WhatsApp asked for a restart after pairing (code 515); waiting for creds to save…",
				),
			);
			try {
				sock.ws?.close();
			} catch {
				// ignore
			}
			await waitForCredsSaveQueueWithTimeout(account.authDir);
			const retry = await createWaSocket(false, verbose, {
				authDir: account.authDir,
			});
			try {
				await wait(retry);
				console.log(success("✅ Linked after restart; web session ready."));
				return;
			} finally {
				setTimeout(() => retry.ws?.close(), 500);
			}
		}
		if (code === LOGGED_OUT_STATUS) {
			await logoutWeb({
				authDir: account.authDir,
				isLegacyAuthDir: account.isLegacyAuthDir,
				runtime,
			});
			console.error(
				danger(
					`WhatsApp reported the session is logged out. Cleared cached web session; please rerun ${formatCliCommand("openclaw channels login")} and scan the QR again.`,
				),
			);
			throw new Error("Session logged out; cache cleared. Re-run login.", {
				cause: err,
			});
		}
		const formatted = formatError(err);
		console.error(
			danger(
				`WhatsApp Web connection ended before fully opening. ${formatted}`,
			),
		);
		throw new Error(formatted, { cause: err });
	} finally {
		// Let Baileys flush any final events before closing the socket.
		setTimeout(() => {
			try {
				sock.ws?.close();
			} catch {
				// ignore
			}
		}, 500);
	}
}
