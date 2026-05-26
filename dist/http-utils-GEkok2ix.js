import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { l as normalizeAgentId, r as buildAgentMainSessionKey } from "./session-key-Bte0mmcq.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-CMp71_27.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { i as parseModelRef, n as modelKey } from "./model-selection-normalize-CBfQo-Fd.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { t as createModelVisibilityPolicy } from "./model-visibility-policy-X7G_tvfc.js";
import { a as getHeader } from "./http-auth-utils-Bn7sdLLK.js";
import { t as loadGatewayModelCatalog } from "./server-model-catalog-YOz_dcEF.js";
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
	const policy = createModelVisibilityPolicy({
		cfg,
		catalog: await loadGatewayModelCatalog(),
		defaultProvider,
		agentId: params.agentId
	});
	const normalized = modelKey(parsed.provider, parsed.model);
	if (!policy.allowsKey(normalized)) return { errorMessage: `Model '${normalized}' is not allowed for agent '${params.agentId}'.` };
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
