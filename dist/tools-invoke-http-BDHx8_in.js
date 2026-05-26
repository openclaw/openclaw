import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as normalizeMessageChannel } from "./message-channel-s-A-ruKR.js";
import { a as sendJson, n as readJsonBodyOrError, o as sendMethodNotAllowed } from "./http-common-DBTbbBna.js";
import { a as getHeader, l as resolveOpenAiCompatibleHttpOperatorScopes, n as authorizeScopedGatewayHttpRequestOrReply, u as resolveOpenAiCompatibleHttpSenderIsOwner } from "./http-auth-utils-Chseq2ys.js";
import "./http-utils-0S65IYEg.js";
import { t as invokeGatewayTool } from "./tools-invoke-shared-DrtzxkAM.js";
//#region src/gateway/tools-invoke-http.ts
const DEFAULT_BODY_BYTES = 2 * 1024 * 1024;
async function handleToolsInvokeHttpRequest(req, res, opts) {
	let url;
	try {
		url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({
			error: "bad_request",
			message: "Invalid request URL"
		}));
		return true;
	}
	if (url.pathname !== "/tools/invoke") return false;
	if (req.method !== "POST") {
		sendMethodNotAllowed(res, "POST");
		return true;
	}
	const authResult = await authorizeScopedGatewayHttpRequestOrReply({
		req,
		res,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter,
		operatorMethod: "agent",
		resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes
	});
	if (!authResult) return true;
	const { cfg, requestAuth } = authResult;
	const bodyUnknown = await readJsonBodyOrError(req, res, opts.maxBodyBytes ?? DEFAULT_BODY_BYTES);
	if (bodyUnknown === void 0) return true;
	const body = bodyUnknown ?? {};
	const messageChannel = normalizeMessageChannel(getHeader(req, "x-openclaw-message-channel") ?? "");
	const accountId = normalizeOptionalString(getHeader(req, "x-openclaw-account-id"));
	const agentTo = normalizeOptionalString(getHeader(req, "x-openclaw-message-to"));
	const agentThreadId = normalizeOptionalString(getHeader(req, "x-openclaw-thread-id"));
	const outcome = await invokeGatewayTool({
		cfg,
		input: body,
		senderIsOwner: resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth),
		messageChannel: messageChannel ?? void 0,
		accountId,
		agentTo,
		agentThreadId,
		toolCallIdPrefix: "http"
	});
	if (outcome.ok) sendJson(res, outcome.status, {
		ok: true,
		result: outcome.result
	});
	else sendJson(res, outcome.status, {
		ok: false,
		error: outcome.error
	});
	return true;
}
//#endregion
export { handleToolsInvokeHttpRequest };
