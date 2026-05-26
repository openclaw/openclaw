import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { a as normalizeModelCompat } from "./provider-model-compat-CmPOKTzc.js";
import { i as COPILOT_INTEGRATION_ID, s as buildCopilotIdeHeaders } from "./copilot-dynamic-headers-CVy4X1Kj.js";
import { f as readProviderJsonArrayFieldResponse } from "./provider-http-errors-C90BH-le.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./provider-model-shared-DtsPmvDx.js";
import "./provider-auth-BtRKd5us.js";
import "./provider-http-CYBE-CBM.js";
import { n as resolveCopilotTransportApi, r as resolveStaticCopilotModelOverride, t as resolveCopilotModelCompat } from "./model-metadata-CuGtXx9C.js";
//#region extensions/github-copilot/models.ts
const PROVIDER_ID = "github-copilot";
const CODEX_FORWARD_COMPAT_TARGET_IDS = new Set(["gpt-5.4", "gpt-5.3-codex"]);
const CODEX_TEMPLATE_MODEL_IDS = ["gpt-5.3-codex", "gpt-5.2-codex"];
const DEFAULT_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 8192;
function isCopilotCodexModelId(modelId) {
	return /(?:^|[-_.])codex(?:$|[-_.])/.test(modelId);
}
function resolveCopilotForwardCompatModel(ctx) {
	const trimmedModelId = ctx.modelId.trim();
	if (!trimmedModelId) return;
	const lowerModelId = normalizeOptionalLowercaseString(trimmedModelId) ?? "";
	if (ctx.modelRegistry.find("github-copilot", lowerModelId)) return;
	if (CODEX_FORWARD_COMPAT_TARGET_IDS.has(lowerModelId)) for (const templateId of CODEX_TEMPLATE_MODEL_IDS) {
		const template = ctx.modelRegistry.find(PROVIDER_ID, templateId);
		if (!template) continue;
		return normalizeModelCompat({
			...template,
			id: trimmedModelId,
			name: trimmedModelId
		});
	}
	const staticOverride = resolveStaticCopilotModelOverride(lowerModelId);
	if (staticOverride) {
		const compat = staticOverride.compat ?? resolveCopilotModelCompat(trimmedModelId);
		return normalizeModelCompat({
			id: trimmedModelId,
			name: staticOverride.name ?? trimmedModelId,
			provider: PROVIDER_ID,
			api: staticOverride.api ?? resolveCopilotTransportApi(trimmedModelId),
			reasoning: staticOverride.reasoning ?? false,
			input: staticOverride.input ?? ["text", "image"],
			cost: staticOverride.cost ?? {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0
			},
			contextWindow: staticOverride.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
			maxTokens: staticOverride.maxTokens ?? DEFAULT_MAX_TOKENS,
			...compat ? { compat } : {}
		});
	}
	const reasoning = /^o[13](\b|$)/.test(lowerModelId) || isCopilotCodexModelId(lowerModelId);
	const compat = resolveCopilotModelCompat(trimmedModelId);
	return normalizeModelCompat({
		id: trimmedModelId,
		name: trimmedModelId,
		provider: PROVIDER_ID,
		api: resolveCopilotTransportApi(trimmedModelId),
		reasoning,
		input: ["text", "image"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
		...compat ? { compat } : {}
	});
}
const COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS = 1e4;
const COPILOT_ROUTER_ID_PREFIX = "accounts/";
function resolveCopilotApiForVendor(vendor, modelId) {
	if (vendor && vendor.toLowerCase() === "anthropic") return "anthropic-messages";
	return resolveCopilotTransportApi(modelId);
}
function mapCopilotApiModelToDefinition(entry) {
	const id = entry.id?.trim();
	if (!id) return;
	if (entry.object && entry.object !== "model") return;
	if (entry.capabilities?.type && entry.capabilities.type !== "chat") return;
	if (id.startsWith(COPILOT_ROUTER_ID_PREFIX)) return;
	const limits = entry.capabilities?.limits;
	const supports = entry.capabilities?.supports;
	const reasoning = Array.isArray(supports?.reasoning_effort) ? supports.reasoning_effort.length > 0 : false;
	const input = supports?.vision === true ? ["text", "image"] : ["text"];
	const contextWindow = typeof limits?.max_context_window_tokens === "number" && limits.max_context_window_tokens > 0 ? limits.max_context_window_tokens : DEFAULT_CONTEXT_WINDOW;
	const maxTokens = typeof limits?.max_output_tokens === "number" && limits.max_output_tokens > 0 ? limits.max_output_tokens : DEFAULT_MAX_TOKENS;
	const compat = resolveCopilotModelCompat(id);
	return {
		id,
		name: entry.name?.trim() || id,
		api: resolveCopilotApiForVendor(entry.vendor, id),
		reasoning,
		input,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow,
		maxTokens,
		...compat ? { compat } : {}
	};
}
function asCopilotApiModelEntry(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Copilot /models: malformed JSON response");
	return value;
}
/**
* Fetch the live Copilot model catalog from `${baseUrl}/models` and project it
* into `ModelDefinitionConfig[]`. Used by the plugin's discovery hook so the
* runtime catalog tracks per-account entitlements + accurate context windows
* without manifest churn.
*
* Filters out non-chat objects (embeddings, routers) and internal router ids.
* On any HTTP/parse failure the caller should fall back to the static manifest
* catalog; this function throws so the caller decides the recovery shape.
*/
async function fetchCopilotModelCatalog(params) {
	const fetchImpl = params.fetchImpl ?? fetch;
	const trimmedBase = params.baseUrl.replace(/\/+$/, "");
	if (!trimmedBase) throw new Error("fetchCopilotModelCatalog: baseUrl required");
	if (!params.copilotApiToken.trim()) throw new Error("fetchCopilotModelCatalog: copilotApiToken required");
	const url = `${trimmedBase}/models`;
	const controller = params.signal ? void 0 : new AbortController();
	const timeoutId = controller ? setTimeout(() => controller.abort(), COPILOT_MODELS_LIST_DEFAULT_TIMEOUT_MS) : void 0;
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${params.copilotApiToken}`,
				...buildCopilotIdeHeaders(),
				"Copilot-Integration-Id": COPILOT_INTEGRATION_ID
			},
			signal: params.signal ?? controller?.signal
		});
		if (!res.ok) throw new Error(`Copilot /models fetch failed: HTTP ${res.status}`);
		const data = await readProviderJsonArrayFieldResponse(res, "Copilot /models", "data");
		const seen = /* @__PURE__ */ new Set();
		const out = [];
		for (const rawEntry of data) {
			const def = mapCopilotApiModelToDefinition(asCopilotApiModelEntry(rawEntry));
			if (!def) continue;
			if (seen.has(def.id)) continue;
			seen.add(def.id);
			out.push(def);
		}
		return out;
	} finally {
		if (timeoutId !== void 0) clearTimeout(timeoutId);
	}
}
//#endregion
export { fetchCopilotModelCatalog as n, resolveCopilotForwardCompatModel as r, PROVIDER_ID as t };
