import { t as __exportAll } from "./rolldown-runtime-C3SqQTfK.js";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
//#region extensions/discord/src/pluralkit.ts
var pluralkit_exports = /* @__PURE__ */ __exportAll({ fetchPluralKitMessageInfo: () => fetchPluralKitMessageInfo });
const PLURALKIT_API_BASE = "https://api.pluralkit.me/v2";
async function fetchPluralKitMessageInfo(params) {
	if (!params.config?.enabled) return null;
	const fetchImpl = resolveFetch(params.fetcher);
	if (!fetchImpl) return null;
	const headers = {};
	if (params.config.token?.trim()) headers.Authorization = params.config.token.trim();
	const res = await fetchImpl(`${PLURALKIT_API_BASE}/messages/${params.messageId}`, { headers });
	if (res.status === 404) return null;
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		const detail = text.trim() ? `: ${text.trim()}` : "";
		throw new Error(`PluralKit API failed (${res.status})${detail}`);
	}
	return await res.json();
}
//#endregion
export { pluralkit_exports as n, fetchPluralKitMessageInfo as t };
