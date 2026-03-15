import { Hn as PROVIDER_LABELS, Ns as parseFiniteNumber$1 } from "./auth-profiles-CuJtivJK.js";
//#region src/infra/provider-usage.fetch.shared.ts
async function fetchJson(url, init, timeoutMs, fetchFn) {
	const controller = new AbortController();
	const timer = setTimeout(controller.abort.bind(controller), timeoutMs);
	try {
		return await fetchFn(url, {
			...init,
			signal: controller.signal
		});
	} finally {
		clearTimeout(timer);
	}
}
function parseFiniteNumber(value) {
	return parseFiniteNumber$1(value);
}
function buildUsageErrorSnapshot(provider, error) {
	return {
		provider,
		displayName: PROVIDER_LABELS[provider],
		windows: [],
		error
	};
}
function buildUsageHttpErrorSnapshot(options) {
	if ((options.tokenExpiredStatuses ?? []).includes(options.status)) {return buildUsageErrorSnapshot(options.provider, "Token expired");}
	const suffix = options.message?.trim() ? `: ${options.message.trim()}` : "";
	return buildUsageErrorSnapshot(options.provider, `HTTP ${options.status}${suffix}`);
}
//#endregion
export { fetchJson as n, parseFiniteNumber as r, buildUsageHttpErrorSnapshot as t };
