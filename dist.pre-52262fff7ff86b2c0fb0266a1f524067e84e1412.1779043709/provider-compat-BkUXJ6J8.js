import { a as normalizeLowercaseStringOrEmpty, f as readStringValue } from "./string-coerce-LndEvhRk.js";
import { r as resolveProviderRequestCapabilities } from "./provider-attribution-BKdrgqZp.js";
import "./string-coerce-runtime-CvivoIwv.js";
import "./provider-http-DWI7l03V.js";
import { n as MISTRAL_MODEL_TRANSPORT_PATCH } from "./api-DdiSQvYc.js";
//#region extensions/mistral/provider-compat.ts
const MISTRAL_MODEL_HINTS = [
	"mistral",
	"mistralai",
	"mixtral",
	"codestral",
	"pixtral",
	"devstral",
	"ministral"
];
function isMistralModelHint(modelId) {
	const normalized = normalizeLowercaseStringOrEmpty(modelId);
	return MISTRAL_MODEL_HINTS.some((hint) => normalized === hint || normalized.startsWith(`${hint}/`) || normalized.startsWith(`${hint}-`) || normalized.startsWith(`${hint}:`));
}
function shouldContributeMistralCompat(params) {
	if (params.model.api !== "openai-completions") return false;
	const capabilities = resolveProviderRequestCapabilities({
		provider: readStringValue(params.model.provider),
		api: "openai-completions",
		baseUrl: readStringValue(params.model.baseUrl),
		capability: "llm",
		transport: "stream",
		modelId: params.modelId,
		compat: params.model.compat && typeof params.model.compat === "object" ? params.model.compat : void 0
	});
	return capabilities.knownProviderFamily === "mistral" || capabilities.endpointClass === "mistral-public" || isMistralModelHint(params.modelId);
}
function contributeMistralResolvedModelCompat(params) {
	return shouldContributeMistralCompat(params) ? MISTRAL_MODEL_TRANSPORT_PATCH : void 0;
}
//#endregion
export { contributeMistralResolvedModelCompat as t };
