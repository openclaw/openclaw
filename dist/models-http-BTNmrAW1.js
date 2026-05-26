import "./agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId, n as listAgentIds } from "./agent-scope-config-CMp71_27.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { n as authorizeOperatorScopesForMethod } from "./method-scopes-D4RcH8qD.js";
import { a as sendJson, i as sendInvalidRequest, o as sendMethodNotAllowed, s as sendMissingScopeForbidden } from "./http-common-D6Lgf8u5.js";
import { l as resolveOpenAiCompatibleHttpOperatorScopes, t as authorizeGatewayHttpRequestOrReply } from "./http-auth-utils-Bn7sdLLK.js";
import { i as resolveAgentIdFromModel, n as OPENCLAW_MODEL_ID, t as OPENCLAW_DEFAULT_MODEL_ID } from "./http-utils-GEkok2ix.js";
//#region src/gateway/models-http.ts
function toOpenAiModel(id) {
	return {
		id,
		object: "model",
		created: 0,
		owned_by: "openclaw",
		permission: []
	};
}
async function authorizeRequest(req, res, opts) {
	return await authorizeGatewayHttpRequestOrReply({
		req,
		res,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter
	});
}
function loadAgentModelIds() {
	const cfg = getRuntimeConfig();
	const defaultAgentId = resolveDefaultAgentId(cfg);
	const ids = new Set([OPENCLAW_MODEL_ID, OPENCLAW_DEFAULT_MODEL_ID]);
	ids.add(`openclaw/${defaultAgentId}`);
	for (const agentId of listAgentIds(cfg)) ids.add(`openclaw/${agentId}`);
	return Array.from(ids);
}
function resolveRequestPath(req) {
	return new URL(req.url ?? "/", "http://localhost").pathname;
}
async function handleOpenAiModelsHttpRequest(req, res, opts) {
	const requestPath = resolveRequestPath(req);
	if (requestPath !== "/v1/models" && !requestPath.startsWith("/v1/models/")) return false;
	if (req.method !== "GET") {
		sendMethodNotAllowed(res, "GET");
		return true;
	}
	const requestAuth = await authorizeRequest(req, res, opts);
	if (!requestAuth) return true;
	const scopeAuth = authorizeOperatorScopesForMethod("models.list", resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth));
	if (!scopeAuth.allowed) {
		sendMissingScopeForbidden(res, scopeAuth.missingScope);
		return true;
	}
	const ids = loadAgentModelIds();
	if (requestPath === "/v1/models") {
		sendJson(res, 200, {
			object: "list",
			data: ids.map(toOpenAiModel)
		});
		return true;
	}
	const encodedId = requestPath.slice(11);
	if (!encodedId) {
		sendInvalidRequest(res, "Missing model id.");
		return true;
	}
	let decodedId;
	try {
		decodedId = decodeURIComponent(encodedId);
	} catch {
		sendInvalidRequest(res, "Invalid model id encoding.");
		return true;
	}
	if (decodedId !== "openclaw" && !resolveAgentIdFromModel(decodedId)) {
		sendInvalidRequest(res, "Invalid model id.");
		return true;
	}
	if (!ids.includes(decodedId)) {
		sendJson(res, 404, { error: {
			message: `Model '${decodedId}' not found.`,
			type: "invalid_request_error"
		} });
		return true;
	}
	sendJson(res, 200, toOpenAiModel(decodedId));
	return true;
}
//#endregion
export { handleOpenAiModelsHttpRequest };
