import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { l as cloneFirstTemplateModel } from "./provider-model-shared-DtsPmvDx.js";
//#region extensions/google/provider-models.ts
const GOOGLE_GEMINI_CLI_PROVIDER_ID = "google-gemini-cli";
const GOOGLE_ANTIGRAVITY_PROVIDER_ID = "google-antigravity";
const GEMINI_2_5_PRO_PREFIX = "gemini-2.5-pro";
const GEMINI_2_5_FLASH_LITE_PREFIX = "gemini-2.5-flash-lite";
const GEMINI_2_5_FLASH_PREFIX = "gemini-2.5-flash";
const GEMINI_3_1_PRO_PREFIX = "gemini-3.1-pro";
const GEMINI_3_1_FLASH_LITE_PREFIX = "gemini-3.1-flash-lite";
const GEMINI_3_1_FLASH_PREFIX = "gemini-3.1-flash";
const GEMINI_3_FLASH_LITE_PREFIX = "gemini-3-flash-lite";
const GEMINI_3_FLASH_PREFIX = "gemini-3-flash";
const GEMINI_PRO_LATEST_ID = "gemini-pro-latest";
const GEMINI_FLASH_LATEST_ID = "gemini-flash-latest";
const GEMINI_FLASH_LITE_LATEST_ID = "gemini-flash-lite-latest";
const GEMMA_PREFIX = "gemma-";
const GEMINI_2_5_PRO_TEMPLATE_IDS = ["gemini-2.5-pro"];
const GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS = ["gemini-2.5-flash-lite"];
const GEMINI_2_5_FLASH_TEMPLATE_IDS = ["gemini-2.5-flash"];
const GEMINI_3_1_PRO_TEMPLATE_IDS = ["gemini-3.1-pro-preview", "gemini-3-pro-preview"];
const GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS = ["gemini-3.1-flash-lite-preview"];
const GEMINI_3_1_FLASH_TEMPLATE_IDS = ["gemini-3-flash-preview", "gemini-2.5-flash"];
const GEMINI_3_PRO_ANTIGRAVITY_TEMPLATE_IDS = ["gemini-3-pro-low", "gemini-3-pro-high"];
const GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS = ["gemini-3-flash"];
const GEMMA_TEMPLATE_IDS = GEMINI_3_1_FLASH_TEMPLATE_IDS;
const GOOGLE_PROVIDER_PREFIX = "google/";
function normalizeGeminiProRequestId(id) {
	if (id.startsWith(GOOGLE_PROVIDER_PREFIX)) {
		const modelId = id.slice(7);
		const normalizedModelId = normalizeGeminiProRequestId(modelId);
		return normalizedModelId === modelId ? id : `${GOOGLE_PROVIDER_PREFIX}${normalizedModelId}`;
	}
	if (id === "gemini-3-pro" || id === "gemini-3-pro-preview" || id === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
	return id;
}
function googleFamilyModelId(id) {
	return id.startsWith(GOOGLE_PROVIDER_PREFIX) ? id.slice(7) : id;
}
function cloneGoogleTemplateModel(params) {
	return cloneFirstTemplateModel({
		providerId: params.templateProviderId,
		modelId: params.modelId,
		templateIds: params.templateIds,
		ctx: params.ctx,
		patch: {
			...params.patch,
			provider: params.providerId
		}
	});
}
function isGoogleGeminiCliProvider(providerId) {
	return normalizeOptionalLowercaseString(providerId) === GOOGLE_GEMINI_CLI_PROVIDER_ID;
}
function isGoogleAntigravityProvider(providerId) {
	return normalizeOptionalLowercaseString(providerId) === GOOGLE_ANTIGRAVITY_PROVIDER_ID;
}
function templateIdsForProvider(templateProviderId, family) {
	if (isGoogleGeminiCliProvider(templateProviderId)) return family.cliTemplateIds;
	if (isGoogleAntigravityProvider(templateProviderId)) return family.antigravityTemplateIds ?? family.googleTemplateIds;
	return family.googleTemplateIds;
}
function buildGoogleTemplateSources(params) {
	const defaultTemplateProviderId = params.templateProviderId?.trim() ? params.templateProviderId : isGoogleGeminiCliProvider(params.providerId) ? "google" : GOOGLE_GEMINI_CLI_PROVIDER_ID;
	const orderedTemplateProviderIds = isGoogleGeminiCliProvider(params.providerId) && params.family.preferExternalFirstForCli === true ? [defaultTemplateProviderId, params.providerId] : [params.providerId, defaultTemplateProviderId];
	const seen = /* @__PURE__ */ new Set();
	const sources = [];
	for (const providerId of orderedTemplateProviderIds) {
		const trimmed = providerId?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		sources.push({
			templateProviderId: trimmed,
			templateIds: templateIdsForProvider(trimmed, params.family)
		});
	}
	return sources;
}
function resolveGoogleGeminiForwardCompatModel(params) {
	const trimmed = normalizeGeminiProRequestId(params.ctx.modelId.trim());
	const lower = normalizeOptionalLowercaseString(googleFamilyModelId(trimmed)) ?? "";
	let family;
	let patch;
	if (lower.startsWith(GEMINI_2_5_PRO_PREFIX)) family = {
		googleTemplateIds: GEMINI_2_5_PRO_TEMPLATE_IDS,
		cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
		preferExternalFirstForCli: true
	};
	else if (lower.startsWith(GEMINI_2_5_FLASH_LITE_PREFIX)) family = {
		googleTemplateIds: GEMINI_2_5_FLASH_LITE_TEMPLATE_IDS,
		cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
		preferExternalFirstForCli: true
	};
	else if (lower.startsWith(GEMINI_2_5_FLASH_PREFIX)) family = {
		googleTemplateIds: GEMINI_2_5_FLASH_TEMPLATE_IDS,
		cliTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
		preferExternalFirstForCli: true
	};
	else if (lower.startsWith(GEMINI_3_1_PRO_PREFIX) || lower === GEMINI_PRO_LATEST_ID) {
		family = {
			googleTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
			cliTemplateIds: GEMINI_3_1_PRO_TEMPLATE_IDS,
			antigravityTemplateIds: GEMINI_3_PRO_ANTIGRAVITY_TEMPLATE_IDS
		};
		if (params.providerId === "google" || params.providerId === GOOGLE_GEMINI_CLI_PROVIDER_ID) patch = { reasoning: true };
	} else if (lower.startsWith(GEMINI_3_1_FLASH_LITE_PREFIX) || lower.startsWith(GEMINI_3_FLASH_LITE_PREFIX) || lower === GEMINI_FLASH_LITE_LATEST_ID) family = {
		googleTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
		cliTemplateIds: GEMINI_3_1_FLASH_LITE_TEMPLATE_IDS,
		antigravityTemplateIds: GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS
	};
	else if (lower.startsWith(GEMINI_3_1_FLASH_PREFIX) || lower.startsWith(GEMINI_3_FLASH_PREFIX) || lower === GEMINI_FLASH_LATEST_ID) family = {
		googleTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
		cliTemplateIds: GEMINI_3_1_FLASH_TEMPLATE_IDS,
		antigravityTemplateIds: GEMINI_3_FLASH_ANTIGRAVITY_TEMPLATE_IDS
	};
	else if (lower.startsWith(GEMMA_PREFIX)) {
		family = {
			googleTemplateIds: GEMMA_TEMPLATE_IDS,
			cliTemplateIds: GEMMA_TEMPLATE_IDS
		};
		if (lower.startsWith("gemma-4")) patch = { reasoning: true };
	} else return;
	for (const source of buildGoogleTemplateSources({
		providerId: params.providerId,
		templateProviderId: params.templateProviderId,
		family
	})) {
		const model = cloneGoogleTemplateModel({
			providerId: params.providerId,
			modelId: trimmed,
			templateProviderId: source.templateProviderId,
			templateIds: source.templateIds,
			ctx: params.ctx,
			patch
		});
		if (model) return model;
	}
}
function isModernGoogleModel(modelId) {
	const lower = normalizeOptionalLowercaseString(modelId) ?? "";
	return lower.startsWith("gemini-2.5") || lower.startsWith("gemini-3") || lower === GEMINI_PRO_LATEST_ID || lower === GEMINI_FLASH_LATEST_ID || lower === GEMINI_FLASH_LITE_LATEST_ID || lower.startsWith(GEMMA_PREFIX);
}
//#endregion
export { resolveGoogleGeminiForwardCompatModel as n, isModernGoogleModel as t };
