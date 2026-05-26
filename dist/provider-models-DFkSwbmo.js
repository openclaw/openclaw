import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { f as readProviderJsonArrayFieldResponse } from "./provider-http-errors-C90BH-le.js";
import "./runtime-env-BtvWnLRh.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./provider-http-CYBE-CBM.js";
//#region extensions/kilocode/provider-models.ts
const log = createSubsystemLogger("kilocode-models");
const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
const KILOCODE_DEFAULT_MODEL_REF = `kilocode/${KILOCODE_DEFAULT_MODEL_ID}`;
const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";
const KILOCODE_MODEL_CATALOG = [{
	id: KILOCODE_DEFAULT_MODEL_ID,
	name: KILOCODE_DEFAULT_MODEL_NAME,
	input: ["text", "image"],
	reasoning: true
}];
const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1e6;
const KILOCODE_DEFAULT_MAX_TOKENS = 128e3;
const KILOCODE_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const KILOCODE_MODELS_URL = `${KILOCODE_BASE_URL}models`;
const DISCOVERY_TIMEOUT_MS = 5e3;
function toPricePerMillion(perToken) {
	if (!perToken) return 0;
	const num = Number(perToken);
	if (!Number.isFinite(num) || num < 0) return 0;
	return num * 1e6;
}
function parseModality(entry) {
	const modalities = entry.architecture?.input_modalities;
	if (!Array.isArray(modalities)) return ["text"];
	return modalities.some((m) => typeof m === "string" && normalizeLowercaseStringOrEmpty(m) === "image") ? ["text", "image"] : ["text"];
}
function parseReasoning(entry) {
	const params = entry.supported_parameters;
	if (!Array.isArray(params)) return false;
	return params.includes("reasoning") || params.includes("include_reasoning");
}
function toModelDefinition(entry) {
	return {
		id: entry.id,
		name: entry.name || entry.id,
		reasoning: parseReasoning(entry),
		input: parseModality(entry),
		cost: {
			input: toPricePerMillion(entry.pricing.prompt),
			output: toPricePerMillion(entry.pricing.completion),
			cacheRead: toPricePerMillion(entry.pricing.input_cache_read),
			cacheWrite: toPricePerMillion(entry.pricing.input_cache_write)
		},
		contextWindow: entry.context_length || 1e6,
		maxTokens: entry.top_provider?.max_completion_tokens ?? 128e3
	};
}
function buildStaticCatalog() {
	return KILOCODE_MODEL_CATALOG.map((model) => ({
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: model.input,
		cost: KILOCODE_DEFAULT_COST,
		contextWindow: model.contextWindow ?? 1e6,
		maxTokens: model.maxTokens ?? 128e3
	}));
}
function asGatewayModelEntry(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Kilocode model list: malformed JSON response");
	const entry = value;
	if (typeof entry.id !== "string" || typeof entry.pricing !== "object" || entry.pricing === null || Array.isArray(entry.pricing)) throw new Error("Kilocode model list: malformed JSON response");
	return value;
}
function readGatewayModelId(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
	const id = value.id;
	return typeof id === "string" ? id.trim() : "";
}
async function discoverKilocodeModels() {
	if (process.env.VITEST) return buildStaticCatalog();
	try {
		const { response, release } = await fetchWithSsrFGuard({
			url: KILOCODE_MODELS_URL,
			init: { headers: { Accept: "application/json" } },
			timeoutMs: DISCOVERY_TIMEOUT_MS,
			policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(KILOCODE_BASE_URL),
			auditContext: "kilocode.model_discovery"
		});
		try {
			if (!response.ok) {
				log.warn(`Failed to discover models: HTTP ${response.status}, using static catalog`);
				return buildStaticCatalog();
			}
			const data = await readProviderJsonArrayFieldResponse(response, "Kilocode model list", "data");
			if (data.length === 0) {
				log.warn("No models found from gateway API, using static catalog");
				return buildStaticCatalog();
			}
			const models = [];
			const discoveredIds = /* @__PURE__ */ new Set();
			for (const rawEntry of data) {
				const id = readGatewayModelId(rawEntry);
				try {
					const entry = asGatewayModelEntry(rawEntry);
					if (!id || discoveredIds.has(id)) continue;
					models.push(toModelDefinition(entry));
					discoveredIds.add(id);
				} catch (e) {
					log.warn(`Skipping malformed model entry "${id}": ${String(e)}`);
				}
			}
			const staticModels = buildStaticCatalog();
			for (const staticModel of staticModels) if (!discoveredIds.has(staticModel.id)) models.unshift(staticModel);
			return models.length > 0 ? models : buildStaticCatalog();
		} finally {
			await release();
		}
	} catch (error) {
		log.warn(`Discovery failed: ${String(error)}, using static catalog`);
		return buildStaticCatalog();
	}
}
function buildKilocodeModelDefinition() {
	return {
		id: KILOCODE_DEFAULT_MODEL_ID,
		name: KILOCODE_DEFAULT_MODEL_NAME,
		reasoning: true,
		input: ["text", "image"],
		cost: KILOCODE_DEFAULT_COST,
		contextWindow: KILOCODE_DEFAULT_CONTEXT_WINDOW,
		maxTokens: KILOCODE_DEFAULT_MAX_TOKENS
	};
}
//#endregion
export { KILOCODE_DEFAULT_MODEL_ID as a, KILOCODE_MODELS_URL as c, discoverKilocodeModels as d, KILOCODE_DEFAULT_MAX_TOKENS as i, KILOCODE_MODEL_CATALOG as l, KILOCODE_DEFAULT_CONTEXT_WINDOW as n, KILOCODE_DEFAULT_MODEL_NAME as o, KILOCODE_DEFAULT_COST as r, KILOCODE_DEFAULT_MODEL_REF as s, KILOCODE_BASE_URL as t, buildKilocodeModelDefinition as u };
