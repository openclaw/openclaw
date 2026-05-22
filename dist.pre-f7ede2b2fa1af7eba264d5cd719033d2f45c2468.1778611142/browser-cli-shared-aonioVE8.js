import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./string-coerce-runtime-B-Wo_S-q.js";
import { n as callGatewayFromCli } from "./gateway-rpc-BaKbjMLQ.js";
import "./core-api-BHTGufQO.js";
//#region extensions/browser/src/cli/browser-cli-shared.ts
function normalizeQuery(query) {
	if (!query) return;
	const out = {};
	for (const [key, value] of Object.entries(query)) {
		if (value === void 0) continue;
		out[key] = String(value);
	}
	return Object.keys(out).length ? out : void 0;
}
async function callBrowserRequest(opts, params, extra) {
	const resolvedTimeoutMs = typeof extra?.timeoutMs === "number" && Number.isFinite(extra.timeoutMs) ? Math.max(1, Math.floor(extra.timeoutMs)) : typeof opts.timeout === "string" ? Number.parseInt(opts.timeout, 10) : void 0;
	const resolvedTimeout = typeof resolvedTimeoutMs === "number" && Number.isFinite(resolvedTimeoutMs) ? resolvedTimeoutMs : void 0;
	const timeout = typeof resolvedTimeout === "number" ? String(resolvedTimeout) : opts.timeout;
	const payload = await callGatewayFromCli("browser.request", {
		...opts,
		timeout
	}, {
		method: params.method,
		path: params.path,
		query: normalizeQuery(params.query),
		body: params.body,
		timeoutMs: resolvedTimeout
	}, { progress: extra?.progress });
	if (payload === void 0) throw new Error("Unexpected browser.request response");
	return payload;
}
async function callBrowserResize(opts, params, extra) {
	return callBrowserRequest(opts, {
		method: "POST",
		path: "/act",
		query: params.profile ? { profile: params.profile } : void 0,
		body: {
			kind: "resize",
			width: params.width,
			height: params.height,
			targetId: normalizeOptionalString(params.targetId)
		}
	}, extra);
}
//#endregion
export { callBrowserResize as n, callBrowserRequest as t };
