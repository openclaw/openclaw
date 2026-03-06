import "./paths-BBP4yd-2.js";
import "./globals-DBA9iEt5.js";
import { d as isRecord } from "./utils-BgHhhQlR.js";
import "./subsystem-B6NrUFrh.js";
import "./logger-JY9zcN88.js";
import { n as fetchWithTimeout } from "./fetch-timeout-j-WSvTr-.js";
import { t as makeProxyFetch } from "./proxy-fetch-D-ERJUt-.js";
import "./proxy-CZ-7bxaR.js";

//#region src/telegram/audit-membership-runtime.ts
const TELEGRAM_API_BASE = "https://api.telegram.org";
async function auditTelegramGroupMembershipImpl(params) {
	const fetcher = params.proxyUrl ? makeProxyFetch(params.proxyUrl) : fetch;
	const base = `${TELEGRAM_API_BASE}/bot${params.token}`;
	const groups = [];
	for (const chatId of params.groupIds) try {
		const res = await fetchWithTimeout(`${base}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(String(params.botId))}`, {}, params.timeoutMs, fetcher);
		const json = await res.json();
		if (!res.ok || !isRecord(json) || !json.ok) {
			const desc = isRecord(json) && !json.ok && typeof json.description === "string" ? json.description : `getChatMember failed (${res.status})`;
			groups.push({
				chatId,
				ok: false,
				status: null,
				error: desc,
				matchKey: chatId,
				matchSource: "id"
			});
			continue;
		}
		const status = isRecord(json.result) ? json.result.status ?? null : null;
		const ok = status === "creator" || status === "administrator" || status === "member";
		groups.push({
			chatId,
			ok,
			status,
			error: ok ? null : "bot not in group",
			matchKey: chatId,
			matchSource: "id"
		});
	} catch (err) {
		groups.push({
			chatId,
			ok: false,
			status: null,
			error: err instanceof Error ? err.message : String(err),
			matchKey: chatId,
			matchSource: "id"
		});
	}
	return {
		ok: groups.every((g) => g.ok),
		checkedGroups: groups.length,
		unresolvedGroups: 0,
		hasWildcardUnmentionedGroups: false,
		groups
	};
}

//#endregion
export { auditTelegramGroupMembershipImpl };