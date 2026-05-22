import { i as formatErrorMessage } from "./errors-D0hgXIu9.js";
import { c as isRecord } from "./utils-927g1oFZ.js";
import { r as fetchWithTimeout } from "./fetch-timeout-DnFd5Ejx.js";
import { r as makeProxyFetch } from "./proxy-fetch-Crv8HXiR.js";
import "./text-runtime-Dm9-PE_c.js";
import "./error-runtime-CEjhuOxx.js";
import { n as resolveTelegramFetch, t as resolveTelegramApiBase } from "./fetch--hLpVgVn.js";
//#region extensions/telegram/src/audit-membership-runtime.ts
async function auditTelegramGroupMembershipImpl(params) {
	const fetcher = resolveTelegramFetch(params.proxyUrl ? makeProxyFetch(params.proxyUrl) : void 0, { network: params.network });
	const base = `${resolveTelegramApiBase(params.apiRoot)}/bot${params.token}`;
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
		const status = isRecord(json.result) && typeof json.result.status === "string" ? json.result.status : null;
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
			error: formatErrorMessage(err),
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
