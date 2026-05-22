import { n as defaultRuntime } from "./runtime-Dv8n03pi.js";
import { n as info, o as success, t as danger } from "./globals-C7I_COwU.js";
import { r as logInfo } from "./logger-CeZgWgtG.js";
import { i as getRuntimeConfig } from "./io-BD1XQ5lD.js";
import "./text-runtime-icMZVCaq.js";
import "./runtime-env-BBcuHj0d.js";
import "./runtime-config-snapshot-BZ-P9buD.js";
import { u as renderQrPngDataUrl } from "./media-runtime-5rxXL-Os.js";
import { a as resolveWhatsAppAccount } from "./accounts-CFRsd5jA.js";
import { d as readWebAuthExistsForDecision, h as readWebSelfId, n as WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store-DE36fFpn.js";
import { a as waitForWhatsAppLoginResult, l as resolveWhatsAppSocketTiming, o as createWaSocket, r as closeWaSocket, t as WHATSAPP_LOGGED_OUT_QR_MESSAGE } from "./connection-controller-CURSSp5G.js";
import { randomUUID } from "node:crypto";
//#region extensions/whatsapp/src/login-qr.ts
function waitForNextTask() {
	return new Promise((resolve) => setImmediate(resolve));
}
const ACTIVE_LOGIN_TTL_MS = 3 * 6e4;
const MAX_QR_RENDER_CHASES = 10;
const activeLogins = /* @__PURE__ */ new Map();
function closeSocket(sock) {
	closeWaSocket(sock);
}
async function resetActiveLogin(accountId, reason) {
	const login = activeLogins.get(accountId);
	if (login) {
		closeSocket(login.sock);
		activeLogins.delete(accountId);
	}
	if (reason) logInfo(reason);
}
function isLoginFresh(login) {
	return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}
function resetQrUpdateSignal(login) {
	login.qrUpdatePromise = new Promise((resolve) => {
		login.resolveQrUpdate = resolve;
	});
}
function notifyQrUpdate(login) {
	const resolve = login.resolveQrUpdate;
	resetQrUpdateSignal(login);
	resolve?.();
}
function updateLoginQrState(login, qr) {
	login.qr = qr;
	login.qrVersion += 1;
	return login.qrVersion;
}
async function ensureQrDataUrl(params) {
	const current = activeLogins.get(params.accountId);
	if (current?.id !== params.loginId || current.qrVersion !== params.qrVersion || current.qr !== params.qr) return await renderQrPngDataUrl(params.qr);
	if (current.qrDataUrl && current.qrDataUrlVersion === params.qrVersion) return current.qrDataUrl;
	if (current.qrRenderPromise) return await current.qrRenderPromise;
	const renderPromise = (async () => {
		for (let attempt = 0; attempt < MAX_QR_RENDER_CHASES; attempt += 1) {
			const latest = activeLogins.get(params.accountId);
			if (!latest || latest.id !== params.loginId || !latest.qr) throw new Error("WhatsApp QR is no longer active.");
			if (latest.qrDataUrl && latest.qrDataUrlVersion === latest.qrVersion) return latest.qrDataUrl;
			const qr = latest.qr;
			const qrVersion = latest.qrVersion;
			const dataUrl = await renderQrPngDataUrl(qr);
			const refreshed = activeLogins.get(params.accountId);
			if (!refreshed || refreshed.id !== params.loginId) return dataUrl;
			if (refreshed.qrVersion === qrVersion && refreshed.qr === qr) {
				refreshed.qrDataUrl = dataUrl;
				refreshed.qrDataUrlVersion = qrVersion;
				notifyQrUpdate(refreshed);
				return dataUrl;
			}
		}
		throw new Error("WhatsApp QR kept refreshing before the latest image could render.");
	})();
	current.qrRenderPromise = renderPromise;
	try {
		return await renderPromise;
	} finally {
		const latest = activeLogins.get(params.accountId);
		if (latest?.id === params.loginId && latest.qrRenderPromise === renderPromise) latest.qrRenderPromise = null;
	}
}
function renderLatestQrDataUrlInBackground(params) {
	ensureQrDataUrl(params).catch(() => {});
}
function attachLoginWaiter(accountId, login) {
	login.waitPromise = waitForWhatsAppLoginResult({
		sock: login.sock,
		authDir: login.authDir,
		isLegacyAuthDir: login.isLegacyAuthDir,
		verbose: login.verbose,
		runtime: login.runtime,
		socketTiming: login.socketTiming,
		onQr: (qr) => {
			const current = activeLogins.get(accountId);
			if (!current || current.id !== login.id) return;
			const qrVersion = updateLoginQrState(current, qr);
			renderLatestQrDataUrlInBackground({
				accountId,
				loginId: login.id,
				qr,
				qrVersion
			});
		},
		onSocketReplaced: (sock) => {
			const current = activeLogins.get(accountId);
			if (current?.id === login.id) {
				current.sock = sock;
				current.connected = false;
				current.error = void 0;
				current.errorStatus = void 0;
			}
		}
	}).then((result) => {
		const current = activeLogins.get(accountId);
		if (current?.id !== login.id) return;
		if (result.outcome === "connected") {
			current.sock = result.sock;
			current.connected = true;
			return;
		}
		current.error = result.message;
		current.errorStatus = result.statusCode;
	}).catch((err) => {
		const current = activeLogins.get(accountId);
		if (current?.id !== login.id) return;
		current.error = err instanceof Error ? err.message : String(err);
		current.errorStatus = void 0;
	});
}
async function waitForQrOrRecoveredLogin(params) {
	const qrResult = params.qrPromise.then((qr) => ({
		outcome: "qr",
		qr
	}), (err) => ({
		outcome: "failed",
		message: `Failed to get QR: ${String(err)}`
	}));
	const loginResult = params.login.waitPromise.then(async () => {
		if (activeLogins.get(params.accountId)?.id !== params.login.id) return {
			outcome: "failed",
			message: "WhatsApp login was replaced by a newer request."
		};
		await waitForNextTask();
		const latest = activeLogins.get(params.accountId);
		if (latest?.id !== params.login.id) return {
			outcome: "failed",
			message: "WhatsApp login was replaced by a newer request."
		};
		if (latest.qr) return {
			outcome: "qr",
			qr: latest.qr
		};
		if (latest.connected) return { outcome: "connected" };
		return {
			outcome: "failed",
			message: latest.error ? `WhatsApp login failed: ${latest.error}` : "WhatsApp login failed."
		};
	});
	return await Promise.race([qrResult, loginResult]);
}
async function startWebLoginWithQr(opts = {}) {
	const runtime = opts.runtime ?? defaultRuntime;
	const cfg = getRuntimeConfig();
	const account = resolveWhatsAppAccount({
		cfg,
		accountId: opts.accountId
	});
	const socketTiming = resolveWhatsAppSocketTiming(cfg);
	const authState = await readWebAuthExistsForDecision(account.authDir);
	if (authState.outcome === "unstable") return {
		code: WHATSAPP_AUTH_UNSTABLE_CODE,
		message: "WhatsApp auth state is still stabilizing. Retry login in a moment."
	};
	if (authState.exists && !opts.force) {
		const selfId = readWebSelfId(account.authDir);
		return { message: `WhatsApp is already linked (${selfId.e164 ?? selfId.jid ?? "unknown"}). Say “relink” if you want a fresh QR.` };
	}
	const existing = activeLogins.get(account.accountId);
	if (existing && isLoginFresh(existing) && existing.qrDataUrl) return {
		qrDataUrl: existing.qrDataUrl,
		message: "QR already active. Scan it in WhatsApp → Linked Devices."
	};
	await resetActiveLogin(account.accountId);
	let resolveQr = null;
	let rejectQr = null;
	const qrPromise = new Promise((resolve, reject) => {
		resolveQr = resolve;
		rejectQr = reject;
	});
	const qrTimer = setTimeout(() => {
		rejectQr?.(/* @__PURE__ */ new Error("Timed out waiting for WhatsApp QR"));
	}, Math.max(opts.timeoutMs ?? 3e4, 5e3));
	let sock;
	let pendingQr = null;
	const loginId = randomUUID();
	try {
		sock = await createWaSocket(false, Boolean(opts.verbose), {
			authDir: account.authDir,
			...socketTiming,
			onQr: (qr) => {
				pendingQr = qr;
				const current = activeLogins.get(account.accountId);
				if (current && current.id === loginId) {
					const qrVersion = updateLoginQrState(current, qr);
					renderLatestQrDataUrlInBackground({
						accountId: account.accountId,
						loginId,
						qr,
						qrVersion
					});
				}
				if (resolveQr) {
					clearTimeout(qrTimer);
					resolveQr(qr);
					resolveQr = null;
					rejectQr = null;
				}
				runtime.log(info("WhatsApp QR received."));
			}
		});
	} catch (err) {
		clearTimeout(qrTimer);
		await resetActiveLogin(account.accountId);
		return { message: `Failed to start WhatsApp login: ${String(err)}` };
	}
	const login = {
		accountId: account.accountId,
		authDir: account.authDir,
		isLegacyAuthDir: account.isLegacyAuthDir,
		id: loginId,
		sock,
		startedAt: Date.now(),
		connected: false,
		waitPromise: Promise.resolve(),
		qrVersion: 0,
		qrUpdatePromise: Promise.resolve(),
		resolveQrUpdate: null,
		qrRenderPromise: null,
		verbose: Boolean(opts.verbose),
		runtime,
		socketTiming
	};
	resetQrUpdateSignal(login);
	activeLogins.set(account.accountId, login);
	if (pendingQr) {
		const qrVersion = updateLoginQrState(login, pendingQr);
		renderLatestQrDataUrlInBackground({
			accountId: account.accountId,
			loginId: login.id,
			qr: pendingQr,
			qrVersion
		});
	}
	attachLoginWaiter(account.accountId, login);
	const loginStartResult = await waitForQrOrRecoveredLogin({
		accountId: account.accountId,
		login,
		qrPromise
	});
	clearTimeout(qrTimer);
	if (loginStartResult.outcome === "connected") {
		const selfId = readWebSelfId(account.authDir);
		const who = selfId.e164 ?? selfId.jid ?? "unknown";
		await resetActiveLogin(account.accountId);
		return {
			message: `WhatsApp recovered the existing linked session (${who}).`,
			connected: true
		};
	}
	if (loginStartResult.outcome === "failed") {
		await resetActiveLogin(account.accountId);
		return { message: loginStartResult.message };
	}
	const qr = login.qr ?? loginStartResult.qr;
	const qrVersion = login.qrVersion;
	if (qrVersion === 0) {
		await resetActiveLogin(account.accountId);
		return { message: "Failed to capture the active WhatsApp QR. Ask me to generate a new one." };
	}
	let qrDataUrl;
	try {
		qrDataUrl = await ensureQrDataUrl({
			accountId: account.accountId,
			loginId: login.id,
			qr,
			qrVersion
		});
	} catch (err) {
		const message = err instanceof Error ? `Failed to render the WhatsApp QR: ${err.message}` : String(err);
		await resetActiveLogin(account.accountId, message);
		return { message };
	}
	return {
		qrDataUrl,
		message: "Scan this QR in WhatsApp → Linked Devices."
	};
}
async function waitForWebLogin(opts = {}) {
	const runtime = opts.runtime ?? defaultRuntime;
	const account = resolveWhatsAppAccount({
		cfg: getRuntimeConfig(),
		accountId: opts.accountId
	});
	const activeLogin = activeLogins.get(account.accountId);
	if (!activeLogin) return {
		connected: false,
		message: "No active WhatsApp login in progress."
	};
	const login = activeLogin;
	if (!isLoginFresh(login)) {
		await resetActiveLogin(account.accountId);
		return {
			connected: false,
			message: "The login QR expired. Ask me to generate a new one."
		};
	}
	const timeoutMs = Math.max(opts.timeoutMs ?? 12e4, 1e3);
	const deadline = Date.now() + timeoutMs;
	const currentQrDataUrl = opts.currentQrDataUrl;
	while (true) {
		if (login.error) {
			if (login.errorStatus === 401) {
				const message = WHATSAPP_LOGGED_OUT_QR_MESSAGE;
				await resetActiveLogin(account.accountId, message);
				runtime.log(danger(message));
				return {
					connected: false,
					message
				};
			}
			const message = `WhatsApp login failed: ${login.error}`;
			await resetActiveLogin(account.accountId, message);
			runtime.log(danger(message));
			return {
				connected: false,
				message
			};
		}
		if (login.connected) {
			const message = "✅ Linked! WhatsApp is ready.";
			runtime.log(success(message));
			await resetActiveLogin(account.accountId);
			return {
				connected: true,
				message
			};
		}
		if (login.qrDataUrl && currentQrDataUrl && login.qrDataUrl !== currentQrDataUrl) return {
			connected: false,
			message: "QR refreshed. Scan the latest code in WhatsApp → Linked Devices.",
			qrDataUrl: login.qrDataUrl
		};
		const remaining = deadline - Date.now();
		if (remaining <= 0) return {
			connected: false,
			message: "Still waiting for the QR scan. Let me know when you’ve scanned it."
		};
		const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), remaining));
		const result = await Promise.race([
			login.waitPromise.then(() => "done"),
			login.qrUpdatePromise.then(() => "qr-update"),
			timeout
		]);
		if (result === "timeout") return {
			connected: false,
			message: "Still waiting for the QR scan. Let me know when you’ve scanned it."
		};
		if (result === "qr-update") continue;
		if (result === "done") {
			if (login.connected || login.error) continue;
			return {
				connected: false,
				message: "Login ended without a connection."
			};
		}
		return {
			connected: false,
			message: "Login ended without a connection."
		};
	}
}
//#endregion
export { startWebLoginWithQr, waitForWebLogin };
