import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-DyL154ka.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as createProviderApiKeyAuthMethod } from "../../provider-api-key-auth-E_5Yag4W.js";
import "../../provider-auth-api-key-C06h8GOX.js";
import { a as STEPFUN_PLAN_PROVIDER_ID, c as STEPFUN_STANDARD_INTL_BASE_URL, i as STEPFUN_PLAN_INTL_BASE_URL, l as buildStepFunPlanProvider, n as STEPFUN_PLAN_CN_BASE_URL, o as STEPFUN_PROVIDER_ID, r as STEPFUN_PLAN_DEFAULT_MODEL_REF, s as STEPFUN_STANDARD_CN_BASE_URL, t as STEPFUN_DEFAULT_MODEL_REF, u as buildStepFunProvider } from "../../provider-catalog-CkR6Ytwv.js";
import { i as applyStepFunStandardConfigCn, n as applyStepFunPlanConfigCn, r as applyStepFunStandardConfig, t as applyStepFunPlanConfig } from "../../onboard-C2zer3nx.js";
//#region extensions/stepfun/index.ts
function trimExplicitBaseUrl(ctx, providerId) {
	const explicitProvider = ctx.config.models?.providers?.[providerId];
	return (typeof explicitProvider?.baseUrl === "string" ? explicitProvider.baseUrl.trim() : "") || void 0;
}
function inferRegionFromBaseUrl(baseUrl) {
	if (!baseUrl) return;
	try {
		const host = normalizeLowercaseStringOrEmpty(new URL(baseUrl).hostname);
		if (host === "api.stepfun.com") return "cn";
		if (host === "api.stepfun.ai") return "intl";
	} catch {
		return;
	}
}
function inferRegionFromProfileId(profileId) {
	if (!profileId) return;
	if (profileId.includes(":cn")) return "cn";
	if (profileId.includes(":intl")) return "intl";
}
function inferRegionFromEnv(env) {
	if (env.STEPFUN_API_KEY?.trim()) return "intl";
}
function inferRegionFromExplicitBaseUrls(ctx) {
	return inferRegionFromBaseUrl(trimExplicitBaseUrl(ctx, "stepfun")) ?? inferRegionFromBaseUrl(trimExplicitBaseUrl(ctx, "stepfun-plan"));
}
function resolveDefaultBaseUrl(surface, region) {
	if (surface === "plan") return region === "cn" ? STEPFUN_PLAN_CN_BASE_URL : STEPFUN_PLAN_INTL_BASE_URL;
	return region === "cn" ? STEPFUN_STANDARD_CN_BASE_URL : STEPFUN_STANDARD_INTL_BASE_URL;
}
function resolveStepFunCatalog(ctx, params) {
	const auth = ctx.resolveProviderAuth(params.providerId);
	const apiKey = auth.apiKey ?? ctx.resolveProviderApiKey(params.providerId).apiKey;
	if (!apiKey) return null;
	const explicitBaseUrl = trimExplicitBaseUrl(ctx, params.providerId);
	const region = inferRegionFromBaseUrl(explicitBaseUrl) ?? inferRegionFromExplicitBaseUrls(ctx) ?? inferRegionFromProfileId(auth.profileId) ?? inferRegionFromEnv(ctx.env);
	const baseUrl = explicitBaseUrl ?? resolveDefaultBaseUrl(params.surface, region ?? "intl");
	return { provider: params.surface === "plan" ? {
		...buildStepFunPlanProvider(baseUrl),
		apiKey
	} : {
		...buildStepFunProvider(baseUrl),
		apiKey
	} };
}
function resolveProfileIds(region) {
	return region === "cn" ? ["stepfun:cn", "stepfun-plan:cn"] : ["stepfun:intl", "stepfun-plan:intl"];
}
function createStepFunApiKeyMethod(params) {
	return createProviderApiKeyAuthMethod({
		providerId: params.providerId,
		methodId: params.methodId,
		label: params.label,
		hint: params.hint,
		optionKey: "stepfunApiKey",
		flagName: "--stepfun-api-key",
		envVar: "STEPFUN_API_KEY",
		promptMessage: params.promptMessage,
		profileIds: resolveProfileIds(params.region),
		allowProfile: false,
		defaultModel: params.defaultModel,
		expectedProviders: [STEPFUN_PROVIDER_ID, STEPFUN_PLAN_PROVIDER_ID],
		applyConfig: params.applyConfig,
		wizard: {
			choiceId: params.choiceId,
			choiceLabel: params.choiceLabel,
			choiceHint: params.choiceHint,
			groupId: "stepfun",
			groupLabel: "StepFun",
			groupHint: "Standard / Step Plan (China / Global)"
		}
	});
}
var stepfun_default = definePluginEntry({
	id: STEPFUN_PROVIDER_ID,
	name: "StepFun",
	description: "Bundled StepFun standard and Step Plan provider plugin",
	register(api) {
		api.registerProvider({
			id: STEPFUN_PROVIDER_ID,
			label: "StepFun",
			docsPath: "/providers/stepfun",
			envVars: ["STEPFUN_API_KEY"],
			auth: [createStepFunApiKeyMethod({
				providerId: STEPFUN_PROVIDER_ID,
				methodId: "standard-api-key-cn",
				label: "StepFun Standard API key (China)",
				hint: "Endpoint: api.stepfun.com/v1",
				region: "cn",
				promptMessage: "Enter StepFun API key for China endpoints",
				defaultModel: STEPFUN_DEFAULT_MODEL_REF,
				choiceId: "stepfun-standard-api-key-cn",
				choiceLabel: "StepFun Standard API key (China)",
				choiceHint: "Endpoint: api.stepfun.com/v1",
				applyConfig: applyStepFunStandardConfigCn
			}), createStepFunApiKeyMethod({
				providerId: STEPFUN_PROVIDER_ID,
				methodId: "standard-api-key-intl",
				label: "StepFun Standard API key (Global/Intl)",
				hint: "Endpoint: api.stepfun.ai/v1",
				region: "intl",
				promptMessage: "Enter StepFun API key for global endpoints",
				defaultModel: STEPFUN_DEFAULT_MODEL_REF,
				choiceId: "stepfun-standard-api-key-intl",
				choiceLabel: "StepFun Standard API key (Global/Intl)",
				choiceHint: "Endpoint: api.stepfun.ai/v1",
				applyConfig: applyStepFunStandardConfig
			})],
			catalog: {
				order: "paired",
				run: async (ctx) => resolveStepFunCatalog(ctx, {
					providerId: STEPFUN_PROVIDER_ID,
					surface: "standard"
				})
			}
		});
		api.registerProvider({
			id: STEPFUN_PLAN_PROVIDER_ID,
			label: "StepFun Step Plan",
			docsPath: "/providers/stepfun",
			envVars: ["STEPFUN_API_KEY"],
			auth: [createStepFunApiKeyMethod({
				providerId: STEPFUN_PLAN_PROVIDER_ID,
				methodId: "plan-api-key-cn",
				label: "StepFun Step Plan API key (China)",
				hint: "Endpoint: api.stepfun.com/step_plan/v1",
				region: "cn",
				promptMessage: "Enter StepFun API key for China endpoints",
				defaultModel: STEPFUN_PLAN_DEFAULT_MODEL_REF,
				choiceId: "stepfun-plan-api-key-cn",
				choiceLabel: "StepFun Step Plan API key (China)",
				choiceHint: "Endpoint: api.stepfun.com/step_plan/v1",
				applyConfig: applyStepFunPlanConfigCn
			}), createStepFunApiKeyMethod({
				providerId: STEPFUN_PLAN_PROVIDER_ID,
				methodId: "plan-api-key-intl",
				label: "StepFun Step Plan API key (Global/Intl)",
				hint: "Endpoint: api.stepfun.ai/step_plan/v1",
				region: "intl",
				promptMessage: "Enter StepFun API key for global endpoints",
				defaultModel: STEPFUN_PLAN_DEFAULT_MODEL_REF,
				choiceId: "stepfun-plan-api-key-intl",
				choiceLabel: "StepFun Step Plan API key (Global/Intl)",
				choiceHint: "Endpoint: api.stepfun.ai/step_plan/v1",
				applyConfig: applyStepFunPlanConfig
			})],
			catalog: {
				order: "paired",
				run: async (ctx) => resolveStepFunCatalog(ctx, {
					providerId: STEPFUN_PLAN_PROVIDER_ID,
					surface: "plan"
				})
			}
		});
	}
});
//#endregion
export { stepfun_default as default };
