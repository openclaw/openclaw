import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { c as isRecord } from "./utils-CKsuXgDI.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { a as resolveAgentModelTimeoutMsValue, i as resolveAgentModelPrimaryValue, r as resolveAgentModelFallbackValues } from "./model-input-B9p-bobB.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-BGwElg4C.js";
import { i as ensureGlobalUndiciEnvProxyDispatcher } from "./undici-global-dispatcher-DbxuiFXu.js";
import { t as hasAnyAuthProfileStoreSource } from "./source-check-BnSDslnj.js";
import { n as ensureAuthProfileStore } from "./store-a4exFSck.js";
import { _ as resolveConfiguredModelRef } from "./model-selection-shared-Dh1KrVmr.js";
import "./model-selection-VRXWv5rs.js";
import { n as normalizeSecretInput } from "./normalize-secret-input-CrCOUFln.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CblHr3q1.js";
import { n as estimateBase64DecodedBytes } from "./base64-6r8Q508J.js";
import "./auth-profiles-vKILPyQ8.js";
import { r as externalCliDiscoveryForProviderAuth } from "./external-cli-discovery-Yd9K5coJ.js";
import { n as listProfilesForProvider } from "./profile-list-1dJMPDMe.js";
import "./model-auth-_bXIM30P.js";
import { n as extractAssistantText } from "./pi-embedded-utils-1bVAKyYK.js";
//#region src/agents/tools/model-config.helpers.ts
function hasToolModelConfig(model) {
	return Boolean(model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0));
}
function resolveDefaultModelRef(cfg) {
	if (cfg) {
		const resolved = resolveConfiguredModelRef({
			cfg,
			defaultProvider: DEFAULT_PROVIDER,
			defaultModel: DEFAULT_MODEL
		});
		return {
			provider: resolved.provider,
			model: resolved.model
		};
	}
	return {
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL
	};
}
function hasAuthForProvider(params) {
	if (resolveEnvApiKey(params.provider)?.apiKey) return true;
	if (params.authStore) return listProfilesForProvider(params.authStore, params.provider).length > 0;
	const agentDir = params.agentDir?.trim();
	if (!agentDir) return false;
	if (!hasAnyAuthProfileStoreSource(agentDir)) return false;
	return listProfilesForProvider(ensureAuthProfileStore(agentDir, { externalCli: externalCliDiscoveryForProviderAuth({ provider: params.provider }) }), params.provider).length > 0;
}
function coerceToolModelConfig(model) {
	const primary = resolveAgentModelPrimaryValue(model);
	const fallbacks = resolveAgentModelFallbackValues(model);
	const timeoutMs = resolveAgentModelTimeoutMsValue(model);
	return {
		...primary?.trim() ? { primary: primary.trim() } : {},
		...fallbacks.length > 0 ? { fallbacks } : {},
		...timeoutMs !== void 0 ? { timeoutMs } : {}
	};
}
function buildToolModelConfigFromCandidates(params) {
	if (hasToolModelConfig(params.explicit)) return params.explicit;
	const deduped = [];
	for (const candidate of params.candidates) {
		const trimmed = candidate?.trim();
		if (!trimmed || !trimmed.includes("/")) continue;
		const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
		const providerConfigured = params.isProviderConfigured?.(provider) ?? hasAuthForProvider({
			provider,
			agentDir: params.agentDir,
			authStore: params.authStore
		});
		if (!provider || !providerConfigured) continue;
		if (!deduped.includes(trimmed)) deduped.push(trimmed);
	}
	if (deduped.length === 0) return null;
	return {
		primary: deduped[0],
		...deduped.length > 1 ? { fallbacks: deduped.slice(1) } : {},
		...params.explicit.timeoutMs !== void 0 ? { timeoutMs: params.explicit.timeoutMs } : {}
	};
}
//#endregion
//#region src/agents/tools/image-tool.helpers.ts
const IMAGE_REASONING_FALLBACK_SIGNATURES = new Set([
	"reasoning_content",
	"reasoning",
	"reasoning_details",
	"reasoning_text"
]);
const MAX_IMAGE_REASONING_FALLBACK_BLOCKS = 50;
const MAX_IMAGE_REASONING_SIGNATURE_PARSE_CHARS = 2048;
const MAX_IMAGE_REASONING_SIGNATURE_SCAN_CHARS = 65536;
function hasResponsesReasoningSignatureMarkers(value) {
	const scanned = value.slice(0, MAX_IMAGE_REASONING_SIGNATURE_SCAN_CHARS);
	return /"id"\s*:\s*"rs_/.test(scanned) && /"type"\s*:\s*"reasoning(?:[."])/.test(scanned);
}
function isImageReasoningFallbackSignature(value) {
	if (!value) return false;
	if (typeof value === "string") {
		if (IMAGE_REASONING_FALLBACK_SIGNATURES.has(value)) return true;
		const trimmed = value.trim();
		if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
		if (trimmed.length > MAX_IMAGE_REASONING_SIGNATURE_PARSE_CHARS) return hasResponsesReasoningSignatureMarkers(trimmed);
		try {
			return isImageReasoningFallbackSignature(JSON.parse(trimmed));
		} catch {
			return false;
		}
	}
	if (typeof value !== "object") return false;
	const record = value;
	const id = typeof record.id === "string" ? record.id : "";
	const type = typeof record.type === "string" ? record.type : "";
	return id.startsWith("rs_") && (type === "reasoning" || type.startsWith("reasoning."));
}
function hasImageReasoningOnlyResponse(message) {
	if (extractAssistantText(message).trim() || !Array.isArray(message.content)) return false;
	let checkedBlocks = 0;
	for (const block of message.content) {
		checkedBlocks += 1;
		if (checkedBlocks > MAX_IMAGE_REASONING_FALLBACK_BLOCKS) break;
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type === "thinking" && typeof record.thinking === "string" && isImageReasoningFallbackSignature(record.thinkingSignature)) return true;
	}
	return false;
}
function decodeDataUrl(dataUrl, opts) {
	const trimmed = dataUrl.trim();
	const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(trimmed);
	if (!match) throw new Error("Invalid data URL (expected base64 data: URL).");
	const mimeType = normalizeLowercaseStringOrEmpty(match[1]);
	if (!mimeType.startsWith("image/")) throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
	const b64 = (match[2] ?? "").trim();
	if (typeof opts?.maxBytes === "number" && estimateBase64DecodedBytes(b64) > opts.maxBytes) throw new Error("Invalid data URL: payload exceeds size limit.");
	const buffer = Buffer.from(b64, "base64");
	if (buffer.length === 0) throw new Error("Invalid data URL: empty payload.");
	return {
		buffer,
		mimeType,
		kind: "image"
	};
}
function coerceImageAssistantText(params) {
	const stop = params.message.stopReason;
	const errorMessage = params.message.errorMessage?.trim();
	if (stop === "error" || stop === "aborted") throw new Error(errorMessage ? `Image model failed (${params.provider}/${params.model}): ${errorMessage}` : `Image model failed (${params.provider}/${params.model})`);
	if (errorMessage) throw new Error(`Image model failed (${params.provider}/${params.model}): ${errorMessage}`);
	const text = extractAssistantText(params.message);
	if (text.trim()) return text.trim();
	throw new Error(`Image model returned no text (${params.provider}/${params.model}).`);
}
function coerceImageModelConfig(cfg) {
	return coerceToolModelConfig(cfg?.agents?.defaults?.imageModel);
}
function formatConfiguredImageModelRef(provider, modelId) {
	const slash = modelId.indexOf("/");
	if (slash > 0 && normalizeProviderId(modelId.slice(0, slash)) === provider) return modelId;
	return `${provider}/${modelId}`;
}
function modelIdMatchesProviderlessRef(params) {
	const candidates = new Set([params.modelId]);
	const slash = params.modelId.indexOf("/");
	if (slash > 0 && normalizeProviderId(params.modelId.slice(0, slash)) === params.provider) candidates.add(params.modelId.slice(slash + 1));
	const normalizedRef = normalizeLowercaseStringOrEmpty(params.ref);
	for (const candidate of candidates) if (candidate === params.ref || normalizeLowercaseStringOrEmpty(candidate) === normalizedRef) return true;
	return false;
}
function findConfiguredImageModelMatches(params) {
	const providers = params.cfg?.models?.providers;
	if (!providers || typeof providers !== "object") return [];
	const matches = /* @__PURE__ */ new Set();
	for (const [providerKey, providerConfig] of Object.entries(providers)) {
		const provider = normalizeProviderId(providerKey);
		if (!provider || !Array.isArray(providerConfig?.models)) continue;
		for (const entry of providerConfig.models) {
			const modelId = entry?.id?.trim();
			if (!modelId || !Array.isArray(entry?.input) || !entry.input.includes("image")) continue;
			if (!modelIdMatchesProviderlessRef({
				provider,
				modelId,
				ref: params.ref
			})) continue;
			matches.add(formatConfiguredImageModelRef(provider, modelId));
		}
	}
	return [...matches];
}
function resolveProviderlessConfiguredImageModelRef(params) {
	const ref = params.ref.trim();
	if (!ref || ref.includes("/")) return ref;
	const matches = findConfiguredImageModelMatches({
		cfg: params.cfg,
		ref
	});
	if (matches.length === 0) return ref;
	if (matches.length === 1) return matches[0];
	throw new Error(`Ambiguous image model "${ref}". Configure a provider-prefixed ref such as ${matches.map((match) => `"${match}"`).join(" or ")}.`);
}
function resolveConfiguredImageModelRefs(params) {
	const primary = params.imageModelConfig.primary?.trim();
	const fallbacks = params.imageModelConfig.fallbacks?.map((ref) => resolveProviderlessConfiguredImageModelRef({
		cfg: params.cfg,
		ref
	})).filter((ref) => ref.length > 0);
	return {
		...params.imageModelConfig.primary !== void 0 ? { primary: primary ? resolveProviderlessConfiguredImageModelRef({
			cfg: params.cfg,
			ref: primary
		}) : primary } : {},
		...fallbacks && fallbacks.length > 0 ? { fallbacks } : {},
		...params.imageModelConfig.timeoutMs !== void 0 ? { timeoutMs: params.imageModelConfig.timeoutMs } : {}
	};
}
function resolveProviderVisionModelFromConfig(params) {
	const id = ((findNormalizedProviderValue(params.cfg?.models?.providers, params.provider)?.models ?? []).find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image"))?.id ?? "").trim();
	if (!id) return null;
	const slash = id.indexOf("/");
	const idProvider = slash === -1 ? "" : normalizeLowercaseStringOrEmpty(id.slice(0, slash));
	const selectedProvider = normalizeLowercaseStringOrEmpty(params.provider);
	return idProvider && idProvider === selectedProvider ? id : `${params.provider}/${id}`;
}
//#endregion
//#region src/agents/minimax-vlm.ts
function isMinimaxVlmProvider(provider) {
	return provider === "minimax" || provider === "minimax-portal";
}
function isMinimaxVlmModel(provider, modelId) {
	return isMinimaxVlmProvider(provider) && modelId.trim() === "MiniMax-VL-01";
}
function coerceApiHost(params) {
	const env = params.env ?? process.env;
	const raw = params.apiHost?.trim() || env.MINIMAX_API_HOST?.trim() || params.modelBaseUrl?.trim() || "https://api.minimax.io";
	try {
		return new URL(raw).origin;
	} catch {}
	try {
		return new URL(`https://${raw}`).origin;
	} catch {
		return "https://api.minimax.io";
	}
}
function pickString(rec, key) {
	const v = rec[key];
	return typeof v === "string" ? v : "";
}
async function minimaxUnderstandImage(params) {
	const apiKey = normalizeSecretInput(params.apiKey);
	if (!apiKey) throw new Error("MiniMax VLM: apiKey required");
	const prompt = params.prompt.trim();
	if (!prompt) throw new Error("MiniMax VLM: prompt required");
	const imageDataUrl = params.imageDataUrl.trim();
	if (!imageDataUrl) throw new Error("MiniMax VLM: imageDataUrl required");
	if (!/^data:image\/(png|jpeg|webp);base64,/i.test(imageDataUrl)) throw new Error("MiniMax VLM: imageDataUrl must be a base64 data:image/(png|jpeg|webp) URL");
	const host = coerceApiHost({
		apiHost: params.apiHost,
		modelBaseUrl: params.modelBaseUrl
	});
	const url = new URL("/v1/coding_plan/vlm", host).toString();
	ensureGlobalUndiciEnvProxyDispatcher();
	const timeoutMs = typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0 ? Math.floor(params.timeoutMs) : 6e4;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			"MM-API-Source": "OpenClaw"
		},
		signal: AbortSignal.timeout(timeoutMs),
		body: JSON.stringify({
			prompt,
			image_url: imageDataUrl
		})
	});
	const traceId = res.headers.get("Trace-Id") ?? "";
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM request failed (${res.status} ${res.statusText}).${trace}${body ? ` Body: ${body.slice(0, 400)}` : ""}`);
	}
	const json = await res.json().catch(() => null);
	if (!isRecord(json)) {
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM response was not JSON.${trace}`);
	}
	const baseResp = isRecord(json.base_resp) ? json.base_resp : {};
	const code = typeof baseResp.status_code === "number" ? baseResp.status_code : -1;
	if (code !== 0) {
		const msg = (baseResp.status_msg ?? "").trim();
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM API error (${code})${msg ? `: ${msg}` : ""}.${trace}`);
	}
	const content = pickString(json, "content").trim();
	if (!content) {
		const trace = traceId ? ` Trace-Id: ${traceId}` : "";
		throw new Error(`MiniMax VLM returned no content.${trace}`);
	}
	return content;
}
//#endregion
export { coerceImageModelConfig as a, resolveConfiguredImageModelRefs as c, coerceToolModelConfig as d, hasAuthForProvider as f, coerceImageAssistantText as i, resolveProviderVisionModelFromConfig as l, resolveDefaultModelRef as m, isMinimaxVlmProvider as n, decodeDataUrl as o, hasToolModelConfig as p, minimaxUnderstandImage as r, hasImageReasoningOnlyResponse as s, isMinimaxVlmModel as t, buildToolModelConfigFromCandidates as u };
