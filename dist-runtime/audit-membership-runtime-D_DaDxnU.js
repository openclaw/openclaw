import "./logger-CRwcgB9y.js";
import "./tmp-openclaw-dir-Bz3ouN_i.js";
import "./paths-Byjx7_T6.js";
import "./subsystem-CsP80x3t.js";
import { l as isRecord } from "./utils-o1tyfnZ_.js";
import { n as fetchWithTimeout } from "./fetch-timeout-csbOmT9G.js";
import "./fetch-Dx857jUp.js";
import "./logger-Bsnck4bK.js";
import { s as makeProxyFetch, t as resolveTelegramFetch } from "./fetch-D2ZOzaXt.js";
//#region extensions/telegram/src/audit-membership-runtime.ts
const TELEGRAM_API_BASE = "https://api.telegram.org";
async function auditTelegramGroupMembershipImpl(params) {
	const fetcher = resolveTelegramFetch(params.proxyUrl ? makeProxyFetch(params.proxyUrl) : void 0, { network: params.network });
	const base = `${TELEGRAM_API_BASE}/bot${params.token}`;
	const groups = [];
	for (const chatId of params.groupIds) {try {
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
	}}
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
