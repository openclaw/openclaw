import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
import { c as normalizeAgentId, r as buildAgentMainSessionKey } from "./session-key-CTLAw4n4.js";
import { S as resolveDefaultAgentId } from "./agent-scope-CzfWAE9r.js";
import { i as getRuntimeConfig } from "./io-DJ0qH7nz.js";
import { u as normalizeMessageChannel } from "./message-channel-B0Hwc40C.js";
import { C as parseModelRef, x as modelKey } from "./model-selection-shared-HUsqLCFt.js";
import { o as resolveDefaultModelForAgent, t as buildAllowedModelSet } from "./model-selection-DqTgZ6sy.js";
import { a as getHeader } from "./http-auth-utils-BwjZga10.js";
import { n as loadGatewayModelCatalog } from "./server-model-catalog-D08-OTlb.js";
import { randomUUID } from "node:crypto";
//#region src/gateway/http-utils.ts
const OPENCLAW_MODEL_ID = "openclaw";
const OPENCLAW_DEFAULT_MODEL_ID = "openclaw/default";
function resolveAgentIdFromHeader(req) {
	const raw = normalizeOptionalString(getHeader(req, "x-openclaw-agent-id")) || normalizeOptionalString(getHeader(req, "x-openclaw-agent")) || "";
	if (!raw) return;
	return normalizeAgentId(raw);
}
function resolveAgentIdFromModel(model, cfg = getRuntimeConfig()) {
	const raw = model?.trim();
	if (!raw) return;
	const lowered = normalizeLowercaseStringOrEmpty(raw);
	if (lowered === "openclaw" || lowered === "openclaw/default") return resolveDefaultAgentId(cfg);
	const agentId = (raw.match(/^openclaw[:/](?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i) ?? raw.match(/^agent:(?<agentId>[a-z0-9][a-z0-9_-]{0,63})$/i))?.groups?.agentId;
	if (!agentId) return;
	return normalizeAgentId(agentId);
}
async function resolveOpenAiCompatModelOverride(params) {
	const requestModel = params.model?.trim();
	if (requestModel && !resolveAgentIdFromModel(requestModel)) return { errorMessage: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`." };
	const raw = getHeader(params.req, "x-openclaw-model")?.trim();
	if (!raw) return {};
	const cfg = getRuntimeConfig();
	const defaultProvider = resolveDefaultModelForAgent({
		cfg,
		agentId: params.agentId
	}).provider;
	const parsed = parseModelRef(raw, defaultProvider);
	if (!parsed) return { errorMessage: "Invalid `x-openclaw-model`." };
	const allowed = buildAllowedModelSet({
		cfg,
		catalog: await loadGatewayModelCatalog(),
		defaultProvider,
		agentId: params.agentId
	});
	const normalized = modelKey(parsed.provider, parsed.model);
	if (!allowed.allowAny && !allowed.allowedKeys.has(normalized)) return { errorMessage: `Model '${normalized}' is not allowed for agent '${params.agentId}'.` };
	return { modelOverride: raw };
}
function resolveAgentIdForRequest(params) {
	const cfg = getRuntimeConfig();
	const fromHeader = resolveAgentIdFromHeader(params.req);
	if (fromHeader) return fromHeader;
	return resolveAgentIdFromModel(params.model, cfg) ?? resolveDefaultAgentId(cfg);
}
function resolveSessionKey(params) {
	const explicit = getHeader(params.req, "x-openclaw-session-key")?.trim();
	if (explicit) return explicit;
	const user = params.user?.trim();
	const mainKey = user ? `${params.prefix}-user:${user}` : `${params.prefix}:${randomUUID()}`;
	return buildAgentMainSessionKey({
		agentId: params.agentId,
		mainKey
	});
}
function resolveGatewayRequestContext(params) {
	const agentId = resolveAgentIdForRequest({
		req: params.req,
		model: params.model
	});
	return {
		agentId,
		sessionKey: resolveSessionKey({
			req: params.req,
			agentId,
			user: params.user,
			prefix: params.sessionPrefix
		}),
		messageChannel: params.useMessageChannelHeader ? normalizeMessageChannel(getHeader(params.req, "x-openclaw-message-channel")) ?? params.defaultMessageChannel : params.defaultMessageChannel
	};
}
//#endregion
export { resolveGatewayRequestContext as a, resolveAgentIdFromModel as i, OPENCLAW_MODEL_ID as n, resolveOpenAiCompatModelOverride as o, resolveAgentIdForRequest as r, OPENCLAW_DEFAULT_MODEL_ID as t };
