import { u as normalizeSecretInputString } from "./types.secrets-CyuYZNvB.js";
import { t as createAccountStatusSink } from "./channel-lifecycle.core-BOahLtCn.js";
import { t as PAIRING_APPROVED_MESSAGE } from "./pairing-message-B7fZ2qTh.js";
import "./channel-lifecycle-ky0xWT7L.js";
import "./accounts-CrHDX5eL.js";
import "./runtime-api-N9POy3P2.js";
import { i as getMe, n as ZaloApiError, t as resolveZaloProxyFetch } from "./proxy-F6sT2_Uo.js";
import { t as sendMessageZalo } from "./send-FsXCX6-M.js";
//#region extensions/zalo/src/probe.ts
async function probeZalo(token, timeoutMs = 5e3, fetcher) {
	if (!token?.trim()) return {
		ok: false,
		error: "No token provided",
		elapsedMs: 0
	};
	const startTime = Date.now();
	try {
		const response = await getMe(token.trim(), timeoutMs, fetcher);
		const elapsedMs = Date.now() - startTime;
		if (response.ok && response.result) return {
			ok: true,
			bot: response.result,
			elapsedMs
		};
		return {
			ok: false,
			error: "Invalid response from Zalo API",
			elapsedMs
		};
	} catch (err) {
		const elapsedMs = Date.now() - startTime;
		if (err instanceof ZaloApiError) return {
			ok: false,
			error: err.description ?? err.message,
			elapsedMs
		};
		if (err instanceof Error) {
			if (err.name === "AbortError") return {
				ok: false,
				error: `Request timed out after ${timeoutMs}ms`,
				elapsedMs
			};
			return {
				ok: false,
				error: err.message,
				elapsedMs
			};
		}
		return {
			ok: false,
			error: String(err),
			elapsedMs
		};
	}
}
//#endregion
//#region extensions/zalo/src/channel.runtime.ts
async function notifyZaloPairingApproval(params) {
	const { resolveZaloAccount } = await import("./accounts-Do58DqyA.js");
	const account = resolveZaloAccount({ cfg: params.cfg });
	if (!account.token) throw new Error("Zalo token not configured");
	await sendMessageZalo(params.id, PAIRING_APPROVED_MESSAGE, { token: account.token });
}
async function sendZaloText(params) {
	return await sendMessageZalo(params.to, params.text, params);
}
async function probeZaloAccount(params) {
	return await probeZalo(params.account.token, params.timeoutMs, resolveZaloProxyFetch(params.account.config.proxy));
}
async function startZaloGatewayAccount(ctx) {
	const account = ctx.account;
	const token = account.token.trim();
	const mode = account.config.webhookUrl ? "webhook" : "polling";
	let zaloBotLabel = "";
	const fetcher = resolveZaloProxyFetch(account.config.proxy);
	try {
		const probe = await probeZalo(token, 2500, fetcher);
		const name = probe.ok ? probe.bot?.name?.trim() : null;
		if (name) zaloBotLabel = ` (${name})`;
		if (!probe.ok) ctx.log?.warn?.(`[${account.accountId}] Zalo probe failed before provider start (${String(probe.elapsedMs)}ms): ${probe.error}`);
		ctx.setStatus({
			accountId: account.accountId,
			bot: probe.bot
		});
	} catch (err) {
		ctx.log?.warn?.(`[${account.accountId}] Zalo probe threw before provider start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
	}
	const statusSink = createAccountStatusSink({
		accountId: ctx.accountId,
		setStatus: ctx.setStatus
	});
	ctx.log?.info(`[${account.accountId}] starting provider${zaloBotLabel} mode=${mode}`);
	const { monitorZaloProvider } = await import("./monitor-CogJ30iM.js");
	return monitorZaloProvider({
		token,
		account,
		config: ctx.cfg,
		runtime: ctx.runtime,
		abortSignal: ctx.abortSignal,
		useWebhook: Boolean(account.config.webhookUrl),
		webhookUrl: account.config.webhookUrl,
		webhookSecret: normalizeSecretInputString(account.config.webhookSecret),
		webhookPath: account.config.webhookPath,
		fetcher,
		statusSink
	});
}
//#endregion
export { notifyZaloPairingApproval, probeZaloAccount, sendZaloText, startZaloGatewayAccount };
