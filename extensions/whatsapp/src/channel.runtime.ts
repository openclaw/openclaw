import { getActiveWebListener as getActiveWebListenerImpl } from "./active-listener.js";
import {
	getWebAuthAgeMs as getWebAuthAgeMsImpl,
	logoutWeb as logoutWebImpl,
	logWebSelfId as logWebSelfIdImpl,
	readWebSelfId as readWebSelfIdImpl,
	webAuthExists as webAuthExistsImpl,
} from "./auth-store.js";
import { monitorWebChannel as monitorWebChannelImpl } from "./auto-reply/monitor.js";
import { loginWeb as loginWebImpl } from "./login.js";
import { whatsappSetupWizard as whatsappSetupWizardImpl } from "./setup-surface.js";

type GetActiveWebListener =
	typeof import("./active-listener.js").getActiveWebListener;
type GetWebAuthAgeMs = typeof import("./auth-store.js").getWebAuthAgeMs;
type LogWebSelfId = typeof import("./auth-store.js").logWebSelfId;
type LogoutWeb = typeof import("./auth-store.js").logoutWeb;
type ReadWebSelfId = typeof import("./auth-store.js").readWebSelfId;
type WebAuthExists = typeof import("./auth-store.js").webAuthExists;
type LoginWeb = typeof import("./login.js").loginWeb;
type StartWebLoginWithQr = typeof import("./login-qr.js").startWebLoginWithQr;
type WaitForWebLogin = typeof import("./login-qr.js").waitForWebLogin;
type WhatsAppSetupWizard =
	typeof import("./setup-surface.js").whatsappSetupWizard;
type MonitorWebChannel =
	typeof import("./auto-reply/monitor.js").monitorWebChannel;

let loginQrPromise: Promise<typeof import("./login-qr.js")> | null = null;

function loadWhatsAppLoginQr() {
	loginQrPromise ??= import("./login-qr.js");
	return loginQrPromise;
}

export function getActiveWebListener(
	...args: Parameters<GetActiveWebListener>
): ReturnType<GetActiveWebListener> {
	return getActiveWebListenerImpl(...args);
}

export function getWebAuthAgeMs(
	...args: Parameters<GetWebAuthAgeMs>
): ReturnType<GetWebAuthAgeMs> {
	return getWebAuthAgeMsImpl(...args);
}

export function logWebSelfId(
	...args: Parameters<LogWebSelfId>
): ReturnType<LogWebSelfId> {
	return logWebSelfIdImpl(...args);
}

export function logoutWeb(
	...args: Parameters<LogoutWeb>
): ReturnType<LogoutWeb> {
	return logoutWebImpl(...args);
}

export function readWebSelfId(
	...args: Parameters<ReadWebSelfId>
): ReturnType<ReadWebSelfId> {
	return readWebSelfIdImpl(...args);
}

export function webAuthExists(
	...args: Parameters<WebAuthExists>
): ReturnType<WebAuthExists> {
	return webAuthExistsImpl(...args);
}

export function loginWeb(...args: Parameters<LoginWeb>): ReturnType<LoginWeb> {
	return loginWebImpl(...args);
}

export async function startWebLoginWithQr(
	...args: Parameters<StartWebLoginWithQr>
): ReturnType<StartWebLoginWithQr> {
	const { startWebLoginWithQr } = await loadWhatsAppLoginQr();
	return await startWebLoginWithQr(...args);
}

export async function waitForWebLogin(
	...args: Parameters<WaitForWebLogin>
): ReturnType<WaitForWebLogin> {
	const { waitForWebLogin } = await loadWhatsAppLoginQr();
	return await waitForWebLogin(...args);
}

export const whatsappSetupWizard: WhatsAppSetupWizard = {
	...whatsappSetupWizardImpl,
};

export function monitorWebChannel(
	...args: Parameters<MonitorWebChannel>
): ReturnType<MonitorWebChannel> {
	return monitorWebChannelImpl(...args);
}
