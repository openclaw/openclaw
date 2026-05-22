import { i as formatErrorMessage } from "./errors-ixwfrboQ.js";
import { c as isRecord } from "./utils-CpmNtyoq.js";
import { r as fetchWithTimeout } from "./fetch-timeout-C5QmHe7w.js";
import { r as makeProxyFetch } from "./proxy-fetch-BypAsJtJ.js";
import { n as resolveTelegramFetch, t as resolveTelegramApiBase } from "./fetch-u3OO_569.js";
import "./error-runtime-BwV5V_90.js";
import "./string-coerce-runtime-Cf3fhT3Z.js";
import "./text-utility-runtime-DSLVVoqA.js";
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
